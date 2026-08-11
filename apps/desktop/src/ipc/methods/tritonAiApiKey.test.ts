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
import { getTritonAiCredentialStatus, updateTritonAiCredentials } from "./tritonAiApiKey.ts";

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
    readonly env?: Record<string, string>;
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
    env: { UCSD_AI_BASE_URL: baseUrl, ...options?.env },
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

describe("TritonAI credential IPC", () => {
  it.effect("reports configured routes without returning key values", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1", {
        env: {
          TRITONAI_ONPREM_API_KEY: "on-prem-secret",
          TRITONAI_FRONTIER_API_KEY: "frontier-secret",
        },
      });
      const result = yield* getTritonAiCredentialStatus
        .handler(undefined)
        .pipe(
          Effect.provide(Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer)),
        );

      assert.deepEqual(result, {
        ready: true,
        usesSharedKey: false,
        onPremConfigured: true,
        frontierConfigured: true,
      });
      assert.notProperty(result, "sharedApiKey");
      assert.notProperty(result, "onPremApiKey");
      assert.notProperty(result, "frontierApiKey");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("persists a shared replacement before restarting only the backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const backendLifecycle: string[] = [];
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1", {
        onStop: () => Effect.sync(() => backendLifecycle.push("stop")),
        onStart: () => Effect.sync(() => backendLifecycle.push("start")),
      });
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.sync(() => {
          assert.equal(request.url, "https://configured.tritonai.example/v1/models");
          assert.equal(request.headers.authorization, "Bearer replacement-key");
          return jsonResponse(request, {
            data: [{ id: "api-deepseek-v4-flash" }, { id: "gpt-5.6-sol" }],
          });
        }),
      );
      const result = yield* updateTritonAiCredentials
        .handler(["replacement-key"])
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );

      assert.deepEqual(result, {
        status: "saved",
        credentials: {
          ready: true,
          usesSharedKey: true,
          onPremConfigured: true,
          frontierConfigured: true,
        },
      });
      const stored = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride.pipe(
        Effect.provide(environmentLayer),
      );
      assert.deepEqual(Option.getOrUndefined(stored), { sharedApiKey: "replacement-key" });
      assert.deepEqual(backendLifecycle, ["stop", "start"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("auto-assigns two keys to on-prem and frontier routes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1");
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.succeed(
          jsonResponse(request, {
            data: [
              {
                id: (request.headers.authorization ?? "").includes("frontier-key")
                  ? "gpt-5.6-sol"
                  : "api-deepseek-v4-flash",
              },
            ],
          }),
        ),
      );

      const result = yield* updateTritonAiCredentials
        .handler(["frontier-key", "on-prem-key"])
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );
      const stored = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride.pipe(
        Effect.provide(environmentLayer),
      );

      assert.equal((result as { status: string }).status, "saved");
      assert.deepEqual(Option.getOrUndefined(stored), {
        onPremApiKey: "on-prem-key",
        frontierApiKey: "frontier-key",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the other configured route when a new key covers only one route", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1", {
        env: { TRITONAI_API_KEY: "existing-shared-key" },
      });
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.succeed(jsonResponse(request, { data: [{ id: "gpt-5.6-sol" }] })),
      );

      yield* updateTritonAiCredentials
        .handler(["new-frontier-key"])
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );
      const stored = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride.pipe(
        Effect.provide(environmentLayer),
      );
      assert.deepEqual(Option.getOrUndefined(stored), {
        onPremApiKey: "existing-shared-key",
        frontierApiKey: "new-frontier-key",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("changes only the selected route when the new key covers both routes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const currentLocal = "current-on-prem-key";
      const currentFrontier = "current-frontier-key";
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1", {
        env: {
          TRITONAI_ONPREM_API_KEY: currentLocal,
          TRITONAI_FRONTIER_API_KEY: currentFrontier,
        },
      });
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.succeed(
          jsonResponse(request, {
            data: [{ id: "api-deepseek-v4-flash" }, { id: "gpt-5.6-sol" }],
          }),
        ),
      );
      const candidate = "new-all-access-key";

      const result = yield* updateTritonAiCredentials
        .handler({ route: "on-prem", apiKey: candidate })
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );
      const stored = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride.pipe(
        Effect.provide(environmentLayer),
      );

      assert.equal((result as { status: string }).status, "saved");
      assert.deepEqual(Option.getOrUndefined(stored), {
        onPremApiKey: candidate,
        frontierApiKey: currentFrontier,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a route-specific key that cannot access the selected route", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      const current = "current-key";
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1", {
        env: { TRITONAI_API_KEY: current },
      });
      const validationLayer = makeHttpClientLayer((request) =>
        Effect.succeed(jsonResponse(request, { data: [{ id: "gpt-5.6-sol" }] })),
      );
      const candidate = "frontier-only-key";

      const result = yield* updateTritonAiCredentials
        .handler({ route: "on-prem", apiKey: candidate })
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );

      assert.deepEqual(result, {
        status: "error",
        message: "This key is active, but it does not include access to on-prem models.",
      });
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
        Effect.succeed(
          jsonResponse(request, {
            data: [{ id: "api-deepseek-v4-flash" }, { id: "gpt-5.6-sol" }],
          }),
        ),
      );

      const result = yield* updateTritonAiCredentials
        .handler(["replacement-key"])
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );

      assert.equal((result as { status: string }).status, "saved");
      assert.deepEqual(backendLifecycle, ["primary-stop", "secondary-stop", "primary-start"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects blank replacements before writing or reconnecting the backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "tritonai-api-key-ipc-test-",
      });
      const environmentLayer = makeEnvironmentLayer(homeDirectory);
      let didRestartBackend = false;
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1", {
        onStop: () => Effect.sync(() => (didRestartBackend = true)),
      });
      const validationLayer = makeHttpClientLayer(() => Effect.die("unexpected validation"));

      const result = yield* updateTritonAiCredentials
        .handler(["   "])
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );
      assert.deepEqual(result, {
        status: "error",
        message: "Enter one or two valid TritonAI access keys.",
      });
      assert.isFalse(didRestartBackend);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps current credentials when TritonAI rejects a replacement", () =>
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
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1", {
        onStop: () => Effect.sync(() => (didRestartBackend = true)),
      });

      yield* DesktopTritonAiApiKey.replaceTritonAiCredentials({
        sharedApiKey: "current-key",
      }).pipe(Effect.provide(environmentLayer));
      const result = yield* updateTritonAiCredentials
        .handler(["rejected-key"])
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );

      assert.deepEqual(result, {
        status: "error",
        message: "TritonAI rejected the access key (HTTP 401).",
      });
      assert.isFalse(didRestartBackend);
      const stored = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride.pipe(
        Effect.provide(environmentLayer),
      );
      assert.deepEqual(Option.getOrUndefined(stored), { sharedApiKey: "current-key" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps current credentials when TritonAI rate-limits validation", () =>
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
      const backendPoolLayer = makeBackendPoolLayer("https://configured.tritonai.example/v1", {
        onStop: () => Effect.sync(() => (didRestartBackend = true)),
      });

      yield* DesktopTritonAiApiKey.replaceTritonAiCredentials({
        sharedApiKey: "current-key",
      }).pipe(Effect.provide(environmentLayer));
      const result = yield* updateTritonAiCredentials
        .handler(["candidate-key"])
        .pipe(
          Effect.provide(
            Layer.mergeAll(environmentLayer, NodeServices.layer, backendPoolLayer, validationLayer),
          ),
        );

      assert.deepEqual(result, {
        status: "error",
        message:
          "TritonAI could not verify the key because it is rate limiting requests (HTTP 429).",
      });
      assert.isFalse(didRestartBackend);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
