// @effect-diagnostics nodeBuiltinImport:off - Effect Crypto has no incremental digest; stream large executables instead of allocating their full contents.
import * as NodeCrypto from "node:crypto";
import * as CodexClient from "effect-codex-app-server/client";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ExternalContent from "../integrations/ExternalContent.ts";

const PROTOCOL = "tritonai.codex-integration-only/v1";
const SOURCE = "979011409de0a60b52f179721948e65531d26144";
const CONTRACT = "9ae8f9674efde0d08394d1f35150b76ac2b97bd04fc8ddcc035b9106a36c9d8c";
const PREFIX = "HARNESS_INTEGRATION_BOUNDARY ";
const encodePolicy = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      protocol: Schema.Literal(PROTOCOL),
      tools: Schema.Array(Schema.String),
    }),
  ),
);
const receiptSchema = Schema.fromJsonString(
  Schema.Struct({
    protocol: Schema.Literal(PROTOCOL),
    upstreamSource: Schema.Literal(SOURCE),
    policySha256: Schema.String,
  }),
);

export class IntegrationCodexRuntimeError extends Schema.TaggedError<IntegrationCodexRuntimeError>()(
  "IntegrationCodexRuntimeError",
  {
    reason: Schema.Literals(["unavailable", "composition", "policy", "startup"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The integration-only Codex runtime is unavailable or does not match the host's trusted composition. No coding runtime was substituted. Ask the environment maintainer to install the reviewed integration runtime.";
  }
}

/** The callback catalog and the host's binary pin are independent of native self-reported receipts. */
export const open = Effect.fn("IntegrationCodexRuntime.open")(function* (input: {
  readonly caller: ExternalContent.ExternalContentCaller;
  readonly nativeTools: ReadonlyArray<string>;
  readonly allowedTools: ReadonlyArray<string>;
  readonly expiresAt: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly configArgs: ReadonlyArray<string>;
  readonly clientOptions?: CodexClient.CodexAppServerClientOptions;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const content = yield* ExternalContent.ExternalContent;
  const pin = config.integrationCodexRuntime;
  if (!pin) return yield* new IntegrationCodexRuntimeError({ reason: "unavailable" });
  if (
    !path.isAbsolute(pin.binaryPath) ||
    !/^[a-f0-9]{64}$/u.test(pin.sha256) ||
    pin.contractSha256 !== CONTRACT
  )
    return yield* new IntegrationCodexRuntimeError({ reason: "composition" });
  const tools = [...new Set(input.nativeTools)].sort();
  if (
    tools.length !== input.nativeTools.length ||
    tools.length > 512 ||
    tools.some((name) => !/^[a-zA-Z0-9_]{1,128}$/u.test(name)) ||
    tools.length !== input.allowedTools.length
  )
    return yield* new IntegrationCodexRuntimeError({ reason: "policy" });
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-integration-codex-" });
  yield* fs.chmod(root, 0o700);
  const binary = path.join(
    root,
    (yield* HostProcess.Platform) === "win32" ? "codex-app-server.exe" : "codex-app-server",
  );
  const stat = yield* fs.stat(pin.binaryPath);
  if (stat.type !== "File" || stat.size <= 0 || stat.size > 1024 * 1024 * 1024)
    return yield* new IntegrationCodexRuntimeError({ reason: "composition" });
  yield* fs.copyFile(pin.binaryPath, binary);
  const hash = NodeCrypto.createHash("sha256");
  yield* fs.stream(binary).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        hash.update(chunk);
      }),
    ),
  );
  if (hash.digest("hex") !== pin.sha256)
    return yield* new IntegrationCodexRuntimeError({ reason: "composition" });
  yield* fs.chmod(binary, 0o500);
  const policy = (yield* encodePolicy({ protocol: PROTOCOL, tools })) + "\n";
  if (new TextEncoder().encode(policy).length > 65_536)
    return yield* new IntegrationCodexRuntimeError({ reason: "policy" });
  const policySha256 = NodeCrypto.createHash("sha256").update(policy).digest("hex");
  const policyPath = path.join(root, "policy.json");
  yield* fs.writeFileString(policyPath, policy, { mode: 0o400 });
  const handle = yield* spawner.spawn(
    ChildProcess.make(
      binary,
      [
        "--harness-integration-policy",
        policyPath,
        "--strict-config",
        "--listen",
        "stdio://",
        ...input.configArgs,
        "-c",
        "features.hooks=false",
        "-c",
        'web_search="disabled"',
      ],
      {
        env: input.environment,
        extendEnv: false,
        cwd: root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    ),
  );
  let live = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      live = false;
    }),
  );
  yield* handle.exitCode.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        live = false;
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  const attested = yield* Deferred.make<void, IntegrationCodexRuntimeError>();
  let found = false;
  let buffered = "";
  const decoder = new TextDecoder();
  const inspect = Effect.fn("IntegrationCodexRuntime.inspectStartup")(function* (
    chunk: Uint8Array,
  ) {
    if (found) return;
    buffered += decoder.decode(chunk, { stream: true });
    if (buffered.length > 65_536) {
      yield* Deferred.fail(attested, new IntegrationCodexRuntimeError({ reason: "startup" }));
      found = true;
      buffered = "";
      return;
    }
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.startsWith(PREFIX)) continue;
      const receipt = yield* Schema.decodeUnknownEffect(receiptSchema)(line.slice(PREFIX.length), {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError((cause) => new IntegrationCodexRuntimeError({ reason: "startup", cause })),
        Effect.result,
      );
      found = true;
      buffered = "";
      if (receipt._tag === "Failure" || receipt.success.policySha256 !== policySha256)
        yield* Deferred.fail(attested, new IntegrationCodexRuntimeError({ reason: "startup" }));
      else yield* Deferred.succeed(attested, undefined);
    }
  });
  // The client owns stderr consumption. Tee its single stream so no competing reader loses the receipt.
  const clientContext = yield* Layer.build(
    CodexClient.layerChildProcess(
      { ...handle, stderr: handle.stderr.pipe(Stream.tap(inspect)) },
      input.clientOptions,
    ),
  );
  yield* Deferred.await(attested).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) => new IntegrationCodexRuntimeError({ reason: "startup", cause })),
  );
  const now = yield* Clock.currentTimeMillis;
  if (!live || input.expiresAt <= now)
    return yield* new IntegrationCodexRuntimeError({ reason: "startup" });
  const scopeId = NodeCrypto.randomUUID();
  yield* content.establish({
    caller: input.caller,
    scopeId,
    boundaryDigest: NodeCrypto.createHash("sha256")
      .update(`${CONTRACT}:${pin.sha256}:${policySha256}`)
      .digest("hex"),
    allowedTools: input.allowedTools,
    expiresAt: input.expiresAt,
    isCurrent: () => live,
  });
  return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );
});
