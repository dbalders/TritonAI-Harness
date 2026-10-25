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
  // regression: #210 fix(desktop): wait for key-change reconnects and show saved key suffixes
  it("omits suffixes for missing keys and never reveals an entire short key", () => {
    for (const key of [undefined, "", "a", "abcd"]) {
      const status = DesktopTritonAiApiKey.credentialStatus(
        key === undefined ? null : { onPremApiKey: key },
      );
      assert.isNull(status.onPremKeyLastFour);
      assert.isNull(status.frontierKeyLastFour);
    }
  });

  it("refuses to send a key to an insecure non-loopback endpoint", () => {
    assert.isNull(
      DesktopTritonAiApiKey.resolveTritonAiModelsEndpoint("http://tritonai.example/v1"),
    );
    assert.equal(
      DesktopTritonAiApiKey.resolveTritonAiModelsEndpoint("http://127.0.0.1:4000/v1"),
      "http://127.0.0.1:4000/v1/models",
    );
  });

  // regression: #154 fix(settings): route TritonAI keys per connection
  it.effect(
    "persists an empty override so removing the last route does not reveal installer keys",
    () =>
      withKeyStore(
        Effect.gen(function* () {
          yield* DesktopTritonAiApiKey.replaceTritonAiCredentials({}, { allowEmpty: true });
          const stored = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride;
          assert.deepEqual(Option.getOrUndefined(stored), {});
        }),
      ),
  );

  it.effect("reads an existing plain-text desktop override as a shared key", () =>
    withKeyStore(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const overridePath = DesktopTritonAiApiKey.tritonAiApiKeyOverridePath(environment);
        yield* fileSystem.makeDirectory(environment.path.dirname(overridePath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(overridePath, "legacy-key\n", { mode: 0o600 });

        const stored = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride;
        assert.deepEqual(Option.getOrUndefined(stored), { sharedApiKey: "legacy-key" });
      }),
    ),
  );

  it.effect("persists split replacements without modifying the installer environment file", () =>
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

        yield* DesktopTritonAiApiKey.replaceTritonAiCredentials({
          onPremApiKey: "on-prem-key",
          frontierApiKey: "frontier-key",
        });

        const stored = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride;
        assert.deepEqual(Option.getOrUndefined(stored), {
          onPremApiKey: "on-prem-key",
          frontierApiKey: "frontier-key",
        });
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

  it.effect("rejects multiline replacements without changing the saved credentials", () =>
    withKeyStore(
      Effect.gen(function* () {
        yield* DesktopTritonAiApiKey.replaceTritonAiCredentials({ sharedApiKey: "current-key" });
        const result = yield* Effect.result(
          DesktopTritonAiApiKey.replaceTritonAiCredentials({
            onPremApiKey: "first\nsecond",
          }),
        );

        assert.equal(result._tag, "Failure");
        const stored = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride;
        assert.deepEqual(Option.getOrUndefined(stored), { sharedApiKey: "current-key" });
      }),
    ),
  );
});
