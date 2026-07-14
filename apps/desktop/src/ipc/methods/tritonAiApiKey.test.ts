import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as DesktopTritonAiApiKey from "../../settings/DesktopTritonAiApiKey.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import { replaceTritonAiApiKey } from "./tritonAiApiKey.ts";

function jsonResponse(request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function makeHttpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, never>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

function makeBackendPoolLayer(baseUrl: string) {
  const currentConfig = {
    env: { UCSD_AI_BASE_URL: baseUrl },
    extendEnv: false,
  } as unknown as DesktopBackendManager.DesktopBackendStartConfig;
  const primary = {
    currentConfig: Effect.succeed(Option.some(currentConfig)),
  } as DesktopBackendManager.DesktopBackendInstance;
  return Layer.succeed(
    DesktopBackendPool.DesktopBackendPool,
    DesktopBackendPool.DesktopBackendPool.of({
      primary: Effect.succeed(primary),
    } as DesktopBackendPool.DesktopBackendPool["Service"]),
  );
}

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

const unusedLifecycleRuntimeLayer = Layer.mergeAll(
  DesktopShutdown.layer,
  DesktopState.layer,
  Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({} as DesktopWindow.DesktopWindow["Service"]),
  ),
  Layer.succeed(
    ElectronApp.ElectronApp,
    ElectronApp.ElectronApp.of({} as ElectronApp.ElectronApp["Service"]),
  ),
  Layer.succeed(
    ElectronTheme.ElectronTheme,
    ElectronTheme.ElectronTheme.of({} as ElectronTheme.ElectronTheme["Service"]),
  ),
);

describe("replaceTritonAiApiKey IPC", () => {
  it.effect("persists the replacement before requesting an app relaunch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const relaunchRequests: Array<{
        readonly reason: string;
        readonly waitForIpcResponse: boolean;
      }> = [];
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
        Effect.provide(environmentLayer),
      );
      const overridePath = DesktopTritonAiApiKey.tritonAiApiKeyOverridePath(environment);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1");
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.sync(() => {
          assert.equal(request.url, "https://configured.tritonai.example/key/info");
          assert.equal(request.headers.authorization, "Bearer replacement-key");
          return jsonResponse(request, { info: { key_alias: "replacement" } });
        }),
      );
      const lifecycleLayer = Layer.succeed(
        DesktopLifecycle.DesktopLifecycle,
        DesktopLifecycle.DesktopLifecycle.of({
          relaunch: (reason, options) =>
            fileSystem.readFileString(overridePath).pipe(
              Effect.orDie,
              Effect.tap((contents) =>
                Effect.sync(() => {
                  assert.equal(contents, "replacement-key\n");
                  relaunchRequests.push({
                    reason,
                    waitForIpcResponse: options?.waitForIpcResponse ?? false,
                  });
                }),
              ),
              Effect.asVoid,
            ),
          register: Effect.void,
        }),
      );

      const result = yield* replaceTritonAiApiKey
        .handler("replacement-key")
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              environmentLayer,
              NodeServices.layer,
              backendPoolLayer,
              validationLayer,
              lifecycleLayer,
              unusedLifecycleRuntimeLayer,
            ),
          ),
        );

      assert.deepEqual(result, { status: "saved" });
      assert.deepEqual(relaunchRequests, [
        { reason: "tritonai-api-key-replaced", waitForIpcResponse: true },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects blank replacements before writing or relaunching", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1");
      const validationLayer = makeHttpClientLayer(() => Effect.die("unexpected validation"));
      const lifecycleLayer = Layer.succeed(
        DesktopLifecycle.DesktopLifecycle,
        DesktopLifecycle.DesktopLifecycle.of({
          relaunch: () => Effect.die("unexpected relaunch"),
          register: Effect.void,
        }),
      );

      const result = yield* replaceTritonAiApiKey
        .handler("   ")
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              environmentLayer,
              NodeServices.layer,
              backendPoolLayer,
              validationLayer,
              lifecycleLayer,
              unusedLifecycleRuntimeLayer,
            ),
          ),
        );
      assert.deepEqual(result, {
        status: "error",
        message: "Enter a valid TritonAI API key.",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the current key and app running when TritonAI rejects the replacement", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1");
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.succeed(jsonResponse(request, { error: "Unauthorized" }, 401)),
      );
      let didRelaunch = false;
      const lifecycleLayer = Layer.succeed(
        DesktopLifecycle.DesktopLifecycle,
        DesktopLifecycle.DesktopLifecycle.of({
          relaunch: () =>
            Effect.sync(() => {
              didRelaunch = true;
            }),
          register: Effect.void,
        }),
      );

      yield* DesktopTritonAiApiKey.replaceTritonAiApiKey("current-key").pipe(
        Effect.provide(environmentLayer),
      );
      const result = yield* replaceTritonAiApiKey
        .handler("rejected-key")
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              environmentLayer,
              NodeServices.layer,
              backendPoolLayer,
              validationLayer,
              lifecycleLayer,
              unusedLifecycleRuntimeLayer,
            ),
          ),
        );

      assert.deepEqual(result, {
        status: "error",
        message: "TritonAI rejected the API key (HTTP 401).",
      });
      assert.isFalse(didRelaunch);
      const stored = yield* DesktopTritonAiApiKey.readTritonAiApiKeyOverride.pipe(
        Effect.provide(environmentLayer),
      );
      assert.equal(stored._tag, "Some");
      if (stored._tag === "Some") assert.equal(stored.value, "current-key");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the current key and app running when TritonAI rate-limits validation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1");
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.succeed(jsonResponse(request, { error: "Rate limited" }, 429)),
      );
      let didRelaunch = false;
      const lifecycleLayer = Layer.succeed(
        DesktopLifecycle.DesktopLifecycle,
        DesktopLifecycle.DesktopLifecycle.of({
          relaunch: () =>
            Effect.sync(() => {
              didRelaunch = true;
            }),
          register: Effect.void,
        }),
      );

      yield* DesktopTritonAiApiKey.replaceTritonAiApiKey("current-key").pipe(
        Effect.provide(environmentLayer),
      );
      const result = yield* replaceTritonAiApiKey
        .handler("candidate-key")
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              environmentLayer,
              NodeServices.layer,
              backendPoolLayer,
              validationLayer,
              lifecycleLayer,
              unusedLifecycleRuntimeLayer,
            ),
          ),
        );

      assert.deepEqual(result, {
        status: "error",
        message:
          "TritonAI could not verify the key because it is rate limiting requests (HTTP 429).",
      });
      assert.isFalse(didRelaunch);
      const stored = yield* DesktopTritonAiApiKey.readTritonAiApiKeyOverride.pipe(
        Effect.provide(environmentLayer),
      );
      assert.equal(stored._tag, "Some");
      if (stored._tag === "Some") assert.equal(stored.value, "current-key");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
