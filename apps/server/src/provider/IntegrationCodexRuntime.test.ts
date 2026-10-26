import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as Config from "../config.ts";
import * as Content from "../integrations/ExternalContent.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Native from "./IntegrationCodexRuntime.ts";

const contract = "9ae8f9674efde0d08394d1f35150b76ac2b97bd04fc8ddcc035b9106a36c9d8c";
const input = {
  caller: {
    ownerId: "thread:launcher",
    providerSessionId: "session",
    providerInstanceId: "provider",
  },
  nativeTools: ["fixture_read"],
  allowedTools: ["fixture.read"],
  expiresAt: 10_000,
  environment: {},
  configArgs: [],
};
const dependencies = Layer.mergeAll(
  NodeServices.layer,
  Sqlite.layerMemory,
  Config.ServerConfig.layerTest(process.cwd(), { prefix: "integration-runtime-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const layer = Content.layer.pipe(Layer.provideMerge(dependencies));
const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Refused composition must not spawn any runtime"),
);

it.effect(
  "does not substitute the installed coding CLI when no trusted runtime is configured",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Native.open(input));
      expect(error).toMatchObject({ _tag: "IntegrationCodexRuntimeError", reason: "unavailable" });
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      Effect.provide(layer),
      Effect.scoped,
    ),
);

it.effect(
  "rejects an unsupported contract, malformed catalog and substituted executable before spawning",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-substitution-" });
      const binaryPath = (yield* Path.Path).join(root, "self-reported-runtime");
      yield* fs.writeFileString(
        binaryPath,
        "A forged runtime receipt is not a trusted binary pin.",
      );
      const pin = { binaryPath, sha256: "0".repeat(64), contractSha256: contract };
      for (const [runtimePin, request, reason] of [
        [{ ...pin, contractSha256: "f".repeat(64) }, input, "composition"],
        [pin, { ...input, nativeTools: ["fixture_read", "fixture_read"] }, "policy"],
        [pin, { ...input, nativeTools: ["fixture_read", "other"] }, "policy"],
        [pin, input, "composition"],
      ] as const) {
        const error = yield* Effect.flip(
          Native.open(request).pipe(
            Effect.provideService(Config.ServerConfig, {
              ...config,
              integrationCodexRuntime: runtimePin,
            }),
          ),
        );
        expect(error).toMatchObject({ _tag: "IntegrationCodexRuntimeError", reason });
      }
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
      Effect.provide(layer),
      Effect.scoped,
    ),
);

it.effect(
  "a startup receipt for a different policy cannot authorize any external-content session",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.ServerConfig;
      const content = yield* Content.ExternalContent;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-receipt-" });
      const binaryPath = (yield* Path.Path).join(root, "fixture-runtime");
      const bytes = new TextEncoder().encode("Synthetic pinned bytes; never executed.");
      yield* fs.writeFile(binaryPath, bytes);
      const digest = yield* (yield* Crypto.Crypto).digest("SHA-256", bytes);
      const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.never,
            stderr: Stream.succeed(
              new TextEncoder().encode(
                'HARNESS_INTEGRATION_BOUNDARY {"protocol":"tritonai.codex-integration-only/v1","upstreamSource":"979011409de0a60b52f179721948e65531d26144","policySha256":"wrong"}\n',
              ),
            ),
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      );
      const error = yield* Effect.flip(
        Native.open(input).pipe(
          Effect.provideService(Config.ServerConfig, {
            ...config,
            integrationCodexRuntime: { binaryPath, sha256, contractSha256: contract },
          }),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      );
      expect(error).toMatchObject({ _tag: "IntegrationCodexRuntimeError", reason: "startup" });
      expect((yield* Effect.flip(content.assertInference(input.caller, true)))._tag).toBe(
        "ExternalContentDenied",
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
);
