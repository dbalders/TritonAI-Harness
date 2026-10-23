import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as ServerConfig from "../config.ts";
import { makeCodexImageContextAnalyzer } from "../provider/CodexImageContext.ts";
import { transcribeVoice } from "../voiceTranscription.ts";
import { TRITONAI_CLIENT_VERSION } from "../tritonAiClientHeaders.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as TritonAiRequestAnalytics from "./TritonAiRequestAnalytics.ts";

it.layer(NodeServices.layer)("gateway request attribution over HTTP", (it) => {
  it.effect.each([true, false])(
    "preserves image/voice requests and Plausible delivery with telemetry enabled=%s",
    (enabled) =>
      Effect.gen(function* () {
        const received: Array<{ path: string; headers: Readonly<Record<string, string>> }> = [];
        let plausibleInstallId: unknown;
        const server = yield* HttpServer.HttpServer;
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            received.push({ path: request.url, headers: request.headers });
            if (request.url === "/api/event") {
              const payload = (yield* request.json) as { props?: { aid?: unknown } };
              plausibleInstallId = payload.props?.aid;
              return HttpServerResponse.empty({ status: 202 });
            }
            if (request.url === "/v1/audio/transcriptions") {
              yield* request.arrayBuffer;
              return yield* HttpServerResponse.json({ text: "local voice fixture" });
            }
            if (request.url === "/v1/chat/completions") {
              yield* request.json;
              return yield* HttpServerResponse.json({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        images: [{ description: "local image fixture", visibleText: "fixture" }],
                      }),
                    },
                  },
                ],
              });
            }
            return HttpServerResponse.empty({ status: 404 });
          }),
        );
        assert.notEqual(server.address._tag, "UnixPathAddress");
        if (server.address._tag === "UnixPathAddress") return;
        const baseUrl = `http://127.0.0.1:${server.address.port}/v1`;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const imagePath = config.stateDir + "/fixture.png";
        yield* fs.writeFileString(imagePath, "synthetic image");
        const imageAnalyzer = yield* makeCodexImageContextAnalyzer({
          TRITONAI_ONPREM_API_KEY: "on-prem-test-only",
          UCSD_AI_BASE_URL: baseUrl,
        });
        assert.deepEqual(
          yield* imageAnalyzer({
            images: [{ name: "fixture.png", path: imagePath, mimeType: "image/png" }],
          }),
          [{ description: "local image fixture", visibleText: "fixture" }],
        );

        assert.deepEqual(
          yield* transcribeVoice(
            {
              audioBase64: Buffer.from("synthetic audio").toString("base64"),
              mimeType: "audio/webm",
            },
            {
              env: { TRITONAI_FRONTIER_API_KEY: "frontier-test-only", UCSD_AI_BASE_URL: baseUrl },
            },
          ),
          { text: "local voice fixture" },
        );

        const plausible = yield* AnalyticsService.AnalyticsService;
        yield* plausible.record("client.turn.requested");
        yield* plausible.flush;
        const gatewayRequests = received.filter((request) => request.path.startsWith("/v1/"));
        assert.equal(gatewayRequests.length, 2);
        assert.equal(gatewayRequests[0]?.headers.authorization, "Bearer on-prem-test-only");
        assert.equal(gatewayRequests[1]?.headers.authorization, "Bearer frontier-test-only");
        for (const [index, purpose] of ["image", "voice"].entries()) {
          const headers = gatewayRequests[index]?.headers ?? {};
          assert.equal(headers["x-tritonai-client"], "harness");
          assert.equal(headers["x-tritonai-client-version"], TRITONAI_CLIENT_VERSION);
          if (enabled) {
            assert.equal(
              headers["x-litellm-tags"],
              `app:tritonai-harness,version:${TRITONAI_CLIENT_VERSION},purpose:${purpose}`,
            );
            assert.equal(
              headers["x-litellm-end-user-id"],
              `harness-install:${String(plausibleInstallId)}`,
            );
          } else {
            assert.equal(headers["x-litellm-tags"], undefined);
            assert.equal(headers["x-litellm-end-user-id"], undefined);
          }
        }
        assert.equal(
          received.filter((request) => request.path === "/api/event").length,
          enabled ? 1 : 0,
        );
        assert.equal(yield* fs.exists(config.anonymousIdPath), enabled);
      }).pipe(
        Effect.provide(
          Layer.merge(AnalyticsService.layer, TritonAiRequestAnalytics.layer).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-gateway-http-" }),
            ),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  T3CODE_TELEMETRY_ENABLED: enabled,
                  TRITONAI_PLAUSIBLE_EVENTS_ENDPOINT: "/api/event",
                }),
              ),
            ),
            Layer.provideMerge(NodeHttpServer.layerTest),
          ),
        ),
        Effect.scoped,
      ),
  );
});
