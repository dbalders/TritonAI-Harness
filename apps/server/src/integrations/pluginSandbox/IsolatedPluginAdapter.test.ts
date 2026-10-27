// @effect-diagnostics nodeBuiltinImport:off -- Fixtures retain exact reviewed policy bytes without depending on a second checkout.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { canonicalJson, type JsonValue } from "@t3tools/shared/pluginSdkContract";
import type * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { scopeIntegrationSecretStore } from "../IntegrationSecretStore.ts";
import { PluginBrokerChannel } from "./PluginBrokerChannel.ts";
import {
  loadIsolatedPluginIntegration,
  type IsolatedPluginRuntime,
} from "./IsolatedPluginAdapter.ts";
import { loadPluginSdkIntegration } from "../pluginSdk/adapter.ts";
import type { KualiBrokerTransport } from "./ReviewedPluginBroker.ts";

const hash = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => Buffer.from(`${canonicalJson(value as JsonValue)}\n`);
const documentId = "a".repeat(24);
const actionId = "b".repeat(24);
const key = "synthetic-host-only-api-key";

async function artifact(id = "synthetic-api-key", changedPolicy = false) {
  const manifest = JSON.parse(
    await NodeFSP.readFile(new URL(`./fixtures/${id}.manifest.txt`, import.meta.url), "utf8"),
  );
  manifest.skills = [];
  const policy = await NodeFSP.readFile(new URL(`./fixtures/${id}.policy.txt`, import.meta.url));
  const policyBytes = changedPolicy
    ? bytes({
        ...JSON.parse(policy.toString()),
        credential: { recipe: "host-api-key/v1", capabilities: [], requiredCapabilities: [] },
      })
    : policy;
  const payloads = [
    { path: ".tritonai-plugin/plugin.json", contents: bytes(manifest) },
    { path: ".tritonai-plugin/broker-policy.json", contents: policyBytes },
    {
      path: "plugin.mjs",
      contents: Buffer.from(
        `throw new Error("Host must never evaluate this module");\nexport function createIntegrationProvider({broker}) { return {invoke:(tool,input)=>broker.request(tool+'.v1',input)}; }\n`,
      ),
    },
  ];
  const descriptor = {
    artifactVersion: 3,
    format: "tritonai.plugin-artifact/v3",
    plugin: { id, version: manifest.version },
    sdk: manifest.sdk,
    target: {
      architecture: "any",
      environments: ["isolated-worker"],
      module: "esm",
      launcherNode: ">=24.13.1 <25",
      platform: "any",
      runtime: "quickjs-wasm",
      executionProfile: "tritonai.quickjs-wasm/v1",
      nodeBuiltins: [],
    },
    entry: "plugin.mjs",
    manifest: ".tritonai-plugin/plugin.json",
    configurationSchema: hash(canonicalJson(manifest.configurationSchema)),
    schemas: manifest.tools
      .map((tool: { name: string; inputSchema: JsonValue }) => ({
        tool: tool.name,
        sha256: hash(canonicalJson(tool.inputSchema)),
      }))
      .sort((a: { tool: string }, b: { tool: string }) => a.tool.localeCompare(b.tool)),
    files: payloads
      .map(({ path, contents }) => ({ path, sha256: hash(contents), size: contents.length }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    broker: {
      protocol: "tritonai.plugin-broker/v1",
      policy: {
        path: ".tritonai-plugin/broker-policy.json",
        sha256: hash(policyBytes),
        id: manifest.broker.policyId,
        version: manifest.broker.policyVersion,
      },
    },
  };
  return [...payloads, { path: "artifact.json", contents: bytes(descriptor) }];
}

async function fixture(
  id = "synthetic-api-key",
  transport: KualiBrokerTransport = async () => ({ apps: [] }),
) {
  const values = new Map<string, Uint8Array>();
  const commits: string[] = [];
  const calls: Parameters<IsolatedPluginRuntime["invoke"]>[0][] = [];
  const state = { forge: false, lose: false };
  const secrets: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    create: () => Effect.void,
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    getOrCreateRandom: (_name, size) => Effect.succeed(new Uint8Array(size)),
  };
  const runtime: IsolatedPluginRuntime = {
    executionProfile: "tritonai.quickjs-wasm/v1" as const,
    workerNodeVersion: "24.22.1",
    async invoke(input) {
      calls.push(input);
      const channel = new PluginBrokerChannel({ ...input.authority, terminate: () => {} });
      channel.beginInvocation(input.toolName, input.parameters, input.context);
      const result = await channel.operation({
        protocol: "tritonai.plugin-broker/v1",
        requestId: 1,
        kind: "operation",
        operationId: `${input.toolName}.v1`,
        parameters: input.parameters,
      });
      if (state.lose) {
        channel.revoke();
        return (await channel.committedResult())!.value;
      }
      return channel.completeInvocation(state.forge ? { forged: true } : result);
    },
  };
  const files = await artifact(id);
  const loaded = await loadIsolatedPluginIntegration({
    files,
    expected: { id, version: "2.0.0" },
    configuration: {},
    secrets,
    runtime,
    transport,
  });
  const provider = loaded.provider!;
  const context = {
    signal: new AbortController().signal,
    beginCommit: async () => {
      commits.push("admitted");
      return new AbortController().signal;
    },
  };
  const capabilities =
    id === "kuali-build"
      ? ["kuali-build.read", "kuali-build.write"]
      : ["synthetic-api-key.read", "synthetic-api-key.write"];
  const connect = async () => {
    const flow = await provider.connect!(capabilities, context);
    if (flow.kind !== "api_key") throw new Error("Expected fresh flow");
    return provider.connect!(capabilities, context, {
      kind: "api_key",
      flowId: flow.flowId,
      value: key,
    });
  };
  return {
    provider,
    values,
    commits,
    calls,
    connect,
    context,
    capabilities,
    state,
    secrets,
    runtime,
    files,
  };
}

it("routes SDK2 only to an admitted isolated runtime without evaluating its entry", async () => {
  const f = await fixture();
  await expect(
    loadPluginSdkIntegration({
      files: f.files,
      secrets: f.secrets,
      configuration: {},
      expected: { id: "synthetic-api-key", version: "2.0.0" },
    }),
  ).rejects.toThrow("quarantined");
  const admitted = await loadPluginSdkIntegration({
    files: f.files,
    secrets: f.secrets,
    configuration: {},
    expected: { id: "synthetic-api-key", version: "2.0.0" },
    isolatedRuntime: f.runtime,
  });
  expect(admitted.provider?.id).toBe("synthetic-api-key");
  expect(f.calls).toEqual([]);
});

it("rejects a release-selected policy even when the new descriptor hashes it correctly", async () => {
  const f = await fixture();
  await expect(
    loadIsolatedPluginIntegration({
      files: await artifact("synthetic-api-key", true),
      secrets: f.secrets,
      configuration: {},
      expected: { id: "synthetic-api-key", version: "2.0.0" },
      runtime: f.runtime,
    }),
  ).rejects.toThrow("host reviewed");
});

it("keeps credentials and lifecycle in the host and retains a synthetic effect across worker instances", async () => {
  const f = await fixture();
  expect((await f.provider.status()).state).toBe("not_connected");
  await f.connect();
  expect(f.commits).toHaveLength(1);
  expect([...f.values.keys()]).toEqual(["integration-synthetic-api-key--connection"]);
  await expect(
    f.provider.invoke("synthetic.items.put", { id: "owned", value: "null is text" }, f.context),
  ).resolves.toEqual({ id: "owned", value: "null is text" });
  await expect(f.provider.invoke("synthetic.items.list", {}, f.context)).resolves.toEqual({
    items: [{ id: "owned", value: "null is text" }],
  });
  expect(JSON.stringify(f.calls.map(({ authority: _authority, ...rest }) => rest))).not.toContain(
    key,
  );
  expect(f.calls[0]?.authority.binding.workerGeneration).not.toBe(
    f.calls[1]?.authority.binding.workerGeneration,
  );
  await f.provider.disconnect!(f.context);
  expect((await f.provider.status()).state).toBe("not_connected");
  expect(f.values.size).toBe(0);
  await expect(f.provider.invoke("synthetic.items.list", {}, f.context)).rejects.toThrow(
    "did not grant",
  );
});

it("consumes API-key flows once and binds them to the requested capabilities", async () => {
  const f = await fixture();
  const flow = await f.provider.connect!(f.capabilities, f.context);
  const submission = { kind: "api_key" as const, flowId: flow.flowId, value: key };
  await expect(f.provider.connect!([f.capabilities[0]!], f.context, submission)).rejects.toThrow(
    "expired or changed",
  );
  await expect(f.provider.connect!(f.capabilities, f.context, submission)).rejects.toThrow(
    "expired or changed",
  );
  expect(f.values.size).toBe(0);
  expect(f.commits).toHaveLength(0);
});

it("requires a host commit callback even if a worker-facing approval boolean is true", async () => {
  const f = await fixture();
  await f.connect();
  await expect(
    f.provider.invoke(
      "synthetic.items.put",
      { id: "owned", value: "x" },
      { signal: f.context.signal, writeApproved: true },
    ),
  ).rejects.toThrow("not admitted");
  expect(f.commits).toHaveLength(1);
  await expect(f.provider.invoke("synthetic.items.list", {}, f.context)).resolves.toEqual({
    items: [],
  });
});

it("runs Kuali version validation before commit and preserves its public result after a forged or lost worker", async () => {
  const events: string[] = [];
  let version: JsonValue = { document: { id: documentId, meta: { updatedAt: 7 } } };
  let receipt: JsonValue = { updateDocument: { id: documentId } };
  const f = await fixture("kuali-build", async ({ document, variables }) => {
    if (document.includes("KualiBuildApps")) return { apps: [] };
    if (document.includes("DocumentVersion")) {
      events.push("precondition");
      return version;
    }
    events.push("mutation");
    expect(variables).toEqual({ id: documentId, data: { text: "annulled null text" } });
    return receipt;
  });
  await f.connect();
  f.commits.length = 0;
  const input = {
    documentId,
    expectedUpdatedAt: "7",
    confirmUpdate: true,
    data: { "data.text": "annulled null text" },
  };
  for (const bad of [
    null,
    { document: { id: documentId, meta: {} } },
    { document: { id: actionId, meta: { updatedAt: 7 } } },
  ]) {
    version = bad;
    await expect(
      f.provider.invoke("kuali-build.documents.update", input, f.context),
    ).rejects.toThrow("version could not be verified");
    expect(f.commits).toHaveLength(0);
    expect(events).not.toContain("mutation");
  }
  version = { document: { id: documentId, meta: { updatedAt: 7 } } };
  for (const lose of [false, true]) {
    f.state.forge = true;
    f.state.lose = lose;
    await expect(
      f.provider.invoke("kuali-build.documents.update", input, f.context),
    ).resolves.toEqual({
      document: { id: documentId },
      updatedFormKeys: ["text"],
      precondition: { expectedUpdatedAt: "7" },
    });
  }
  receipt = { updateDocument: { id: actionId } };
  await expect(f.provider.invoke("kuali-build.documents.update", input, f.context)).rejects.toThrow(
    "could not be confirmed",
  );
});

it("does not admit nested nulls or request sizes that the Kuali host cannot send", async () => {
  const f = await fixture("kuali-build");
  await f.connect();
  f.commits.length = 0;
  for (const data of [{ x: { text: [null] } }, { x: "x".repeat(32_769) }]) {
    await expect(
      f.provider.invoke(
        "kuali-build.documents.update",
        { documentId, expectedUpdatedAt: "7", confirmUpdate: true, data },
        f.context,
      ),
    ).rejects.toThrow();
    expect(f.commits).toHaveLength(0);
  }
});

it("revokes a pending precondition when the connection closes without admitting its write", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<JsonValue>();
  const f = await fixture("kuali-build", async ({ document }) => {
    if (document.includes("KualiBuildApps")) return { apps: [] };
    entered.resolve();
    return finish.promise;
  });
  await f.connect();
  f.commits.length = 0;
  const request = f.provider.invoke(
    "kuali-build.documents.update",
    { documentId, expectedUpdatedAt: "7", confirmUpdate: true, data: { x: "owned" } },
    f.context,
  );
  const rejected = expect(request).rejects.toThrow();
  await Promise.race([
    entered.promise,
    request.then(() => {
      throw new Error("Invocation completed before the precondition");
    }),
  ]);
  await f.provider.close!();
  finish.resolve({ document: { id: documentId, meta: { updatedAt: 7 } } });
  await rejected;
  expect(f.commits).toHaveLength(0);
});

it.effect("rejects an API-key flow after another host client replaces its credential", () =>
  Effect.gen(function* () {
    const f = yield* Effect.promise(() => fixture());
    const flow = yield* Effect.promise(() => f.provider.connect!(f.capabilities, f.context));
    const scoped = scopeIntegrationSecretStore(f.secrets, "synthetic-api-key");
    const replacement = JSON.stringify({
      apiKey: "newer-host-owned-key",
      capabilities: f.capabilities,
    });
    yield* scoped.set("connection", new TextEncoder().encode(replacement));
    yield* Effect.promise(() =>
      expect(
        f.provider.connect!(f.capabilities, f.context, {
          kind: "api_key",
          flowId: flow.flowId,
          value: key,
        }),
      ).rejects.toThrow("expired or changed"),
    );
    expect(f.commits).toHaveLength(0);
    expect(
      new TextDecoder().decode(f.values.get("integration-synthetic-api-key--connection")),
    ).toBe(replacement);
  }),
);

it.effect("rechecks the shared credential generation after asynchronous API-key verification", () =>
  Effect.gen(function* () {
    const entered = Promise.withResolvers<void>();
    const verified = Promise.withResolvers<JsonValue>();
    const f = yield* Effect.promise(() =>
      fixture("kuali-build", async () => {
        entered.resolve();
        return verified.promise;
      }),
    );
    const flow = yield* Effect.promise(() => f.provider.connect!(f.capabilities, f.context));
    const submission = f.provider.connect!(f.capabilities, f.context, {
      kind: "api_key",
      flowId: flow.flowId,
      value: key,
    });
    const rejected = expect(submission).rejects.toThrow("changed before credential persistence");
    yield* Effect.promise(() =>
      Promise.race([
        entered.promise,
        submission.then(() => {
          throw new Error("Unexpected early connection");
        }),
      ]),
    );
    const replacement = JSON.stringify({
      version: 1,
      apiKey: "newer-host-owned-key",
      capabilities: f.capabilities,
    });
    yield* scopeIntegrationSecretStore(f.secrets, "kuali-build").set(
      "api-key",
      new TextEncoder().encode(replacement),
    );
    verified.resolve({ apps: [] });
    yield* Effect.promise(() => rejected);
    expect(f.commits).toHaveLength(0);
    expect(new TextDecoder().decode(f.values.get("integration-kuali-build--api-key"))).toBe(
      replacement,
    );
  }),
);
