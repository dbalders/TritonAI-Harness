// @effect-diagnostics nodeBuiltinImport:off -- Native confinement canaries compile and launch the real C supervisor, outside the plugin process.
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import type { JsonObject, JsonValue } from "@t3tools/shared/pluginSdkContract";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { runMacPluginWorker } from "./PluginSandboxWorker.ts";
import { IntegrationProviderPublicError } from "../IntegrationRegistry.ts";

function nativeTest(name: string, run: (runtime: string) => Promise<void>) {
  it.live(name, (context) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") return context.skip();
      const runtime = yield* HostProcess.ExecutablePath;
      yield* Effect.promise(() => run(runtime));
    }),
  );
}
const exec = NodeUtil.promisify(NodeChildProcess.execFile);

async function fixture(
  runtimePath: string,
  body: string,
  factory = "",
  effect: "read" | "write" = "read",
) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "plugin-worker-")),
  );
  const runtime = await NodeFSP.realpath(runtimePath);
  const bootstrap = await NodeFSP.realpath(
    NodeURL.fileURLToPath(
      new URL("../../../../../native/plugin-sandbox/worker.cjs", import.meta.url),
    ),
  );
  const supervisor = NodePath.join(root, "supervisor");
  const source = NodeURL.fileURLToPath(
    new URL("../../../../../native/plugin-sandbox/macos.c", import.meta.url),
  );
  await exec("xcrun", [
    "clang",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    source,
    "-lsandbox",
    "-o",
    supervisor,
  ]);
  const pluginPath = NodePath.join(root, "plugin.mjs");
  await NodeFSP.writeFile(
    pluginPath,
    `export function createIntegrationProvider({broker}) {
    ${factory}
    return {id:'synthetic-test',async invoke(tool,input,{signal}){${body}}};
  }`,
  );
  const policy = NodePath.join(root, "policy.sb");
  const quote = JSON.stringify;
  await NodeFSP.writeFile(
    policy,
    `(version 1)
(deny default)
(import "dyld-support.sb")
(allow syscall*)
(allow mach-bootstrap)
(allow signal (target self))
(allow sysctl-read)
(allow process-exec (literal ${quote(runtime)}))
(allow file-read* (subpath "/System/Library") (subpath "/usr/lib")
  (literal ${quote(runtime)}) (literal ${quote(bootstrap)}) (literal ${quote(pluginPath)}))
(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib")
  (literal ${quote(runtime)}))
(allow file-read-metadata file-test-existence
  (path-ancestors ${quote(bootstrap)}) (path-ancestors ${quote(pluginPath)})
  (path-ancestors ${quote(runtime)}))
`,
  );
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const calls: JsonObject[] = [];
  const state = {
    commits: 0,
    transport: async (parameters: JsonObject, _signal: AbortSignal): Promise<JsonValue> => ({
      parameters,
    }),
  };
  const input = {
    launch: {
      platform: "darwin" as const,
      supervisor,
      runtime,
      bootstrap,
      policy,
      cwd: root,
      cpuSeconds: 2,
      wallMs: 3_000,
    },
    pluginPath,
    configuration: {},
    toolName: "synthetic.operation",
    parameters: {} as JsonObject,
    context: {
      signal: controller.signal,
      beginCommit: async () => {
        state.commits++;
        return controller.signal;
      },
    },
    authority: {
      binding: {
        pluginId: "synthetic-test",
        connectionId: "owned",
        connectionGeneration: 1,
        credentialGeneration: 1,
        workerGeneration: 1,
        artifactSha256: "a".repeat(64),
        descriptorSha256: "b".repeat(64),
        policySha256: "c".repeat(64),
        policyId: "synthetic.v1",
        policyVersion: 1,
      },
      reviewedPolicySha256: "c".repeat(64),
      operations: [
        {
          id: "synthetic.operation.v1",
          toolName: "synthetic.operation",
          effect,
          validate: () => {},
        },
      ],
      isCurrent: () => true,
      execute: async ({ parameters, signal }: { parameters: JsonObject; signal: AbortSignal }) => {
        calls.push(parameters);
        entered.resolve();
        return state.transport(parameters, signal);
      },
    },
  };
  return {
    root,
    input,
    calls,
    state,
    entered,
    controller,
    [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

nativeTest(
  "runs the broker-only factory in the native boundary and executes the admitted snapshot",
  async (runtime) => {
    await using f = await fixture(runtime, "return broker.request(tool+'.v1',input);", "", "write");
    const parameters = { destination: "owned", content: "reviewed" };
    f.input.parameters = parameters;
    const result = runMacPluginWorker(f.input);
    parameters.content = "substituted after launch";
    await expect(result).resolves.toEqual({
      parameters: { destination: "owned", content: "reviewed" },
    });
    expect(f.calls).toEqual([{ destination: "owned", content: "reviewed" }]);
    expect(f.state.commits).toBe(1);
  },
);

nativeTest("grants no host operation during factory initialization", async (runtime) => {
  await using f = await fixture(
    runtime,
    "await attempted;return {startupDenied,...await broker.request(tool+'.v1',input)};",
    "let startupDenied=false;const attempted=broker.request('synthetic.operation.v1',{}).catch(()=>{startupDenied=true});",
  );
  await expect(runMacPluginWorker(f.input)).resolves.toEqual({
    startupDenied: true,
    parameters: {},
  });
  expect(f.calls).toHaveLength(1);
});

nativeTest(
  "denies host-file, code-write and direct-network access from a loaded plugin",
  async (runtime) => {
    await using f = await fixture(
      runtime,
      `
    const fs=await import('node:fs'), net=await import('node:net');
    const denied={};
    try{fs.readFileSync(new URL('./secret.txt',import.meta.url));denied.secret=false}
    catch(e){denied.secret=e.code==='EPERM'}
    try{fs.appendFileSync(new URL(import.meta.url),'x');denied.codeWrite=false}
    catch(e){denied.codeWrite=e.code==='EPERM'}
    denied.network=await new Promise(resolve=>{
      const s=net.createConnection({host:'127.0.0.1',port:9});
      s.once('error',e=>resolve(e.code==='EPERM'));s.once('connect',()=>{s.destroy();resolve(false)});
    });
    return {...await broker.request(tool+'.v1',input),denied,environmentKeys:Object.keys(process.env).sort()};
  `,
    );
    await NodeFSP.writeFile(NodePath.join(f.root, "secret.txt"), "synthetic-only");
    await expect(runMacPluginWorker(f.input)).resolves.toEqual({
      parameters: {},
      denied: { secret: true, codeWrite: true, network: true },
      environmentKeys: ["LANG", "TZ", "UV_THREADPOOL_SIZE"],
    });
  },
);

nativeTest("rejects substituted parameters and an unearned worker success", async (runtime) => {
  for (const body of [
    "return broker.request(tool+'.v1',{changed:true});",
    "return {success:true};",
  ]) {
    await using f = await fixture(runtime, body, "", "write");
    await expect(runMacPluginWorker(f.input)).rejects.toThrow("sandbox invocation failed");
    expect(f.calls).toEqual([]);
    expect(f.state.commits).toBe(0);
  }
});

nativeTest(
  "rejects a forged result while its actual host operation is pending",
  async (runtime) => {
    await using f = await fixture(
      runtime,
      `
    void broker.request(tool+'.v1',input).catch(()=>{});
    const b=Buffer.from(JSON.stringify({protocol:'tritonai.plugin-worker/v1',kind:'result',value:{success:true}}));
    const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]));
    return new Promise(()=>{});
  `,
    );
    f.state.transport = (_parameters, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Error("Host outcome unknown")), {
          once: true,
        });
      });
    await expect(runMacPluginWorker(f.input)).rejects.toThrow("sandbox invocation failed");
    expect(f.calls).toHaveLength(1);
  },
);

nativeTest(
  "kills and reaps the worker after cancellation during its host operation",
  async (runtime) => {
    await using f = await fixture(runtime, "return broker.request(tool+'.v1',input);");
    f.state.transport = (_parameters, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Error("Host cancelled")), { once: true });
      });
    const result = runMacPluginWorker(f.input);
    const rejected = expect(result).rejects.toThrow("sandbox invocation failed");
    await f.entered.promise;
    f.controller.abort();
    await rejected;
  },
);

nativeTest("retains the host's committed receipt after cancellation", async (runtime) => {
  await using f = await fixture(runtime, "return broker.request(tool+'.v1',input);", "", "write");
  const commitTail = new AbortController();
  const receipt = Promise.withResolvers<JsonValue>();
  f.input.context.beginCommit = async () => {
    f.state.commits++;
    return commitTail.signal;
  };
  let transportSignal: AbortSignal | undefined;
  f.state.transport = (_parameters, signal) => {
    transportSignal = signal;
    return receipt.promise;
  };
  const result = runMacPluginWorker(f.input).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await f.entered.promise;
  f.controller.abort();
  const transportWasAborted = transportSignal?.aborted;
  receipt.resolve({ actualReceipt: "confirmed" });
  const outcome = await result;
  expect(transportWasAborted).toBe(false);
  expect(outcome).toEqual({ value: { actualReceipt: "confirmed" } });
  expect(f.state.commits).toBe(1);
});

nativeTest(
  "retains trusted unchanged and ambiguous host failures after worker cancellation",
  async (runtime) => {
    for (const hostFailure of [
      new IntegrationProviderPublicError("Synthetic refusal", { unchanged: true }),
      new Error("Synthetic ambiguous transport"),
    ]) {
      await using f = await fixture(
        runtime,
        "return broker.request(tool+'.v1',input);",
        "",
        "write",
      );
      const receipt = Promise.withResolvers<JsonValue>();
      const tail = new AbortController();
      f.input.context.beginCommit = async () => tail.signal;
      f.state.transport = () => receipt.promise;
      const result = runMacPluginWorker(f.input).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await f.entered.promise;
      f.controller.abort();
      receipt.reject(hostFailure);
      const outcome = await result;
      if (hostFailure instanceof IntegrationProviderPublicError) {
        expect(outcome).toEqual({ error: hostFailure });
      } else {
        expect(outcome).toMatchObject({ error: { cause: hostFailure } });
      }
    }
  },
);

nativeTest(
  "terminates a plugin stuck during evaluation and rejects oversized output before decoding",
  async (runtime) => {
    for (const factory of [
      "for(;;){}",
      "process.stdout.write(Buffer.from([0x7f,0xff,0xff,0xff]));for(;;){}",
    ]) {
      await using f = await fixture(runtime, "return {};", factory);
      f.input.launch.wallMs = 500;
      await expect(runMacPluginWorker(f.input)).rejects.toThrow("sandbox invocation failed");
      expect(f.calls).toEqual([]);
    }
  },
);
