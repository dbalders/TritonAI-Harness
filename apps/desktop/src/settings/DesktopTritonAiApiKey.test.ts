import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopTritonAiApiKey from "./DesktopTritonAiApiKey.ts";

function makeEnvironmentLayer(homeDirectory: string) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: homeDirectory })),
    ),
  );
}

const withKeyStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "tritonai-api-key-test-",
    });
    return yield* effect.pipe(Effect.provide(makeEnvironmentLayer(homeDirectory)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopTritonAiApiKey", () => {
  it("resolves validation against the configured TritonAI endpoint", () => {
    assert.equal(
      DesktopTritonAiApiKey.resolveTritonAiKeyInfoEndpoint(
        "https://configured.tritonai.example/v1",
      ),
      "https://configured.tritonai.example/key/info",
    );
  });

  it("refuses to send a key to an insecure non-loopback endpoint", () => {
    assert.isNull(
      DesktopTritonAiApiKey.resolveTritonAiKeyInfoEndpoint("http://tritonai.example/v1"),
    );
    assert.equal(
      DesktopTritonAiApiKey.resolveTritonAiKeyInfoEndpoint("http://127.0.0.1:4000/v1"),
      "http://127.0.0.1:4000/key/info",
    );
  });

  it.effect("persists a replacement without modifying the installer environment file", () =>
    withKeyStore(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const installerEnvPath = environment.path.join(
          environment.homeDirectory,
          ".agents",
          "ucsd",
          "env",
        );
        yield* fileSystem.makeDirectory(environment.path.dirname(installerEnvPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          installerEnvPath,
          "export TRITONAI_API_KEY='setup-key'\n",
        );

        yield* DesktopTritonAiApiKey.replaceTritonAiApiKey("  new-key  ");

        const stored = yield* DesktopTritonAiApiKey.readTritonAiApiKeyOverride;
        assert.isTrue(Option.isSome(stored));
        assert.equal(Option.getOrUndefined(stored), "new-key");
        assert.equal(
          yield* fileSystem.readFileString(installerEnvPath),
          "export TRITONAI_API_KEY='setup-key'\n",
        );

        const overridePath = DesktopTritonAiApiKey.tritonAiApiKeyOverridePath(environment);
        const info = yield* fileSystem.stat(overridePath);
        assert.equal(info.mode & 0o777, 0o600);
        assert.isTrue(overridePath.startsWith(environment.stateDir));
      }),
    ),
  );

  it.effect("atomically replaces an earlier desktop override", () =>
    withKeyStore(
      Effect.gen(function* () {
        yield* DesktopTritonAiApiKey.replaceTritonAiApiKey("first-key");
        yield* DesktopTritonAiApiKey.replaceTritonAiApiKey("second-key");

        const stored = yield* DesktopTritonAiApiKey.readTritonAiApiKeyOverride;
        assert.equal(Option.getOrUndefined(stored), "second-key");
      }),
    ),
  );

  it.effect("rejects multiline replacements without changing the saved key", () =>
    withKeyStore(
      Effect.gen(function* () {
        yield* DesktopTritonAiApiKey.replaceTritonAiApiKey("current-key");
        const result = yield* Effect.result(
          DesktopTritonAiApiKey.replaceTritonAiApiKey("first\nsecond"),
        );

        assert.equal(result._tag, "Failure");
        const stored = yield* DesktopTritonAiApiKey.readTritonAiApiKeyOverride;
        assert.equal(Option.getOrUndefined(stored), "current-key");
      }),
    ),
  );
});
