import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { makeTritonAiClientHeaders } from "../tritonAiClientHeaders.ts";
import * as TritonAiRequestAnalytics from "./TritonAiRequestAnalytics.ts";

it.layer(NodeServices.layer)("TritonAiRequestAnalytics", (it) => {
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
});
