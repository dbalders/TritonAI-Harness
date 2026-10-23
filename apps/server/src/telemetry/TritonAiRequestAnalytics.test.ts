import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { makeTritonAiClientHeaders, TRITONAI_CLIENT_VERSION } from "../tritonAiClientHeaders.ts";
import { getAnonymousInstallId } from "./Identify.ts";
import * as TritonAiRequestAnalytics from "./TritonAiRequestAnalytics.ts";

const installId = "0b3f1d9e-5c2a-4e7b-9a41-2f6c8d0e7a15";
const enabled = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: true }),
);

it.layer(NodeServices.layer)("TritonAiRequestAnalytics", (it) => {
  it.effect("reuses the persisted Plausible identity across routes, purposes, and restarts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(config.anonymousIdPath, `${installId}\n`);
      const start = TritonAiRequestAnalytics.TritonAiRequestAnalytics.pipe(
        Effect.provide(TritonAiRequestAnalytics.layer.pipe(Layer.provide(enabled))),
      );
      const first = yield* start;
      const second = yield* start;
      for (const purpose of ["chat", "ideas", "help", "image", "voice"] as const) {
        const headers = first.headers(purpose);
        assert.deepEqual(headers, {
          ...makeTritonAiClientHeaders(),
          "x-litellm-tags": `app:tritonai-harness,version:${TRITONAI_CLIENT_VERSION},purpose:${purpose}`,
          "x-litellm-end-user-id": `harness-install:${installId}`,
        });
        assert.deepEqual(second.headers(purpose), headers);
      }
      assert.equal((yield* fs.readFileString(config.anonymousIdPath)).trim(), installId);
      assert.deepEqual(yield* getAnonymousInstallId, Option.some(installId));
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-gateway-identity-" })),
    ),
  );

  it.effect.each([false, "invalid"])(
    "omits analytics and does not create an ID when telemetry is %s",
    (value) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const analytics = yield* TritonAiRequestAnalytics.TritonAiRequestAnalytics.pipe(
          Effect.provide(
            TritonAiRequestAnalytics.layer.pipe(
              Layer.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: value }),
                ),
              ),
            ),
          ),
        );
        assert.deepEqual(analytics.headers("chat"), makeTritonAiClientHeaders());
        assert.deepEqual(analytics.headers("voice"), makeTritonAiClientHeaders());
        assert.isFalse(yield* fs.exists(config.anonymousIdPath));
      }).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-gateway-opt-out-" })),
      ),
  );

  it.effect("keeps model requests usable without inventing an ID when storage fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.anonymousIdPath);
      const analytics = yield* TritonAiRequestAnalytics.TritonAiRequestAnalytics.pipe(
        Effect.provide(TritonAiRequestAnalytics.layer.pipe(Layer.provide(enabled))),
      );
      assert.deepEqual(analytics.headers("chat"), {
        ...makeTritonAiClientHeaders(),
        "x-litellm-tags": `app:tritonai-harness,version:${TRITONAI_CLIENT_VERSION},purpose:chat`,
      });
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-gateway-no-identity-" })),
    ),
  );

  it.effect("bounds a stalled identity read and keeps requests unidentified", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>();
      const hangingStorage = FileSystem.layerNoop({
        readFileString: () =>
          Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = yield* TritonAiRequestAnalytics.TritonAiRequestAnalytics.pipe(
        Effect.provide(
          TritonAiRequestAnalytics.layer.pipe(Layer.provide([hangingStorage, enabled])),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(readStarted);
      yield* TestClock.adjust("1 second");
      const analytics = yield* Fiber.join(fiber);
      assert.equal(analytics.headers("chat")["x-litellm-end-user-id"], undefined);
      assert.include(analytics.headers("chat")["x-litellm-tags"] ?? "", "purpose:chat");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-gateway-slow-identity-" }),
      ),
    ),
  );
});
