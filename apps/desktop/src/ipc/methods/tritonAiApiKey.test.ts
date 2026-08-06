import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopTritonAiApiKey from "../../settings/DesktopTritonAiApiKey.ts";
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

function makeBackendPoolLayer(
  baseUrl: string,
  options?: {
    readonly onStop?: () => Effect.Effect<void>;
    readonly onStart?: () => Effect.Effect<void>;
    readonly desiredRunning?: boolean;
    readonly additionalBackends?: ReadonlyArray<{
      readonly onStop?: () => Effect.Effect<void>;
      readonly onStart?: () => Effect.Effect<void>;
      readonly desiredRunning?: boolean;
    }>;
  },
) {
  const currentConfig = {
    env: { UCSD_AI_BASE_URL: baseUrl },
    extendEnv: false,
  } as unknown as DesktopBackendManager.DesktopBackendStartConfig;
  const makeBackend = (backendOptions?: {
    readonly onStop?: () => Effect.Effect<void>;
    readonly onStart?: () => Effect.Effect<void>;
    readonly desiredRunning?: boolean;
  }) =>
    ({
      currentConfig: Effect.succeed(Option.some(currentConfig)),
      snapshot: Effect.succeed({
        desiredRunning: backendOptions?.desiredRunning ?? true,
      } as DesktopBackendManager.DesktopBackendSnapshot),
      stop: () => backendOptions?.onStop?.() ?? Effect.void,
      start: backendOptions?.onStart?.() ?? Effect.void,
    }) as DesktopBackendManager.DesktopBackendInstance;
  const primary = makeBackend(options);
  const backends = [
    primary,
    ...(options?.additionalBackends ?? []).map((backendOptions) => makeBackend(backendOptions)),
  ];
  return Layer.succeed(
    DesktopBackendPool.DesktopBackendPool,
    DesktopBackendPool.DesktopBackendPool.of({
      primary: Effect.succeed(primary),
      list: Effect.succeed(backends),
    } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
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

describe("replaceTritonAiApiKey IPC", () => {
  it.effect("persists the replacement before restarting only the backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const backendLifecycle: string[] = [];
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
        Effect.provide(environmentLayer),
      );
      const overridePath = DesktopTritonAiApiKey.tritonAiApiKeyOverridePath(environment);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1", {
        onStop: () =>
          fileSystem.readFileString(overridePath).pipe(
            Effect.orDie,
            Effect.tap((contents) =>
              Effect.sync(() => {
                assert.equal(contents, "replacement-key\n");
                backendLifecycle.push("stop");
              }),
            ),
            Effect.asVoid,
          ),
        onStart: () =>
          Effect.sync(() => {
            backendLifecycle.push("start");
          }),
      });
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.sync(() => {
          assert.equal(request.url, "https://configured.tritonai.example/key/info");
          assert.equal(request.headers.authorization, "Bearer replacement-key");
          return jsonResponse(request, { info: { key_alias: "replacement" } });
        }),
      );
      const result = yield* replaceTritonAiApiKey
        .handler("replacement-key")
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );

      assert.deepEqual(result, { status: "saved" });
      assert.deepEqual(backendLifecycle, ["stop", "start"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not start a backend that was already stopped", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const backendLifecycle: string[] = [];
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1", {
        onStop: () => Effect.sync(() => backendLifecycle.push("primary-stop")),
        onStart: () => Effect.sync(() => backendLifecycle.push("primary-start")),
        additionalBackends: [
          {
            desiredRunning: false,
            onStop: () => Effect.sync(() => backendLifecycle.push("secondary-stop")),
            onStart: () => Effect.sync(() => backendLifecycle.push("secondary-start")),
          },
        ],
      });
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.succeed(jsonResponse(request, { info: { key_alias: "replacement" } })),
      );

      const result = yield* replaceTritonAiApiKey
        .handler("replacement-key")
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );

      assert.deepEqual(result, { status: "saved" });
      assert.deepEqual(backendLifecycle, ["primary-stop", "secondary-stop", "primary-start"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects blank replacements before writing or restarting the backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1");
      const validationLayer = makeHttpClientLayer(() => Effect.die("unexpected validation"));

      const result = yield* replaceTritonAiApiKey
        .handler("   ")
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
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
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.succeed(jsonResponse(request, { error: "Unauthorized" }, 401)),
      );
      let didRestartBackend = false;
      const guardedBackendPoolLayer = makeBackendPoolLayer(
        "https://configured.tritonai.example/v1",
        { onStop: () => Effect.sync(() => (didRestartBackend = true)) },
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
              guardedBackendPoolLayer,
              validationLayer,
            ),
          ),
        );

      assert.deepEqual(result, {
        status: "error",
        message: "TritonAI rejected the API key (HTTP 401).",
      });
      assert.isFalse(didRestartBackend);
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
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.succeed(jsonResponse(request, { error: "Rate limited" }, 429)),
      );
      let didRestartBackend = false;
      const guardedBackendPoolLayer = makeBackendPoolLayer(
        "https://configured.tritonai.example/v1",
        { onStop: () => Effect.sync(() => (didRestartBackend = true)) },
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
              guardedBackendPoolLayer,
              validationLayer,
            ),
          ),
        );

      assert.deepEqual(result, {
        status: "error",
        message:
          "TritonAI could not verify the key because it is rate limiting requests (HTTP 429).",
      });
      assert.isFalse(didRestartBackend);
      const stored = yield* DesktopTritonAiApiKey.readTritonAiApiKeyOverride.pipe(
        Effect.provide(environmentLayer),
      );
      assert.equal(stored._tag, "Some");
      if (stored._tag === "Some") assert.equal(stored.value, "current-key");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
