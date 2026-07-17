import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface RecordedEventRequest {
  readonly path: string;
  readonly userAgent: string | undefined;
  readonly body: {
    readonly domain?: string;
    readonly name?: string;
    readonly url?: string;
    readonly props?: Readonly<Record<string, unknown>>;
  } | null;
}

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("flush delivers buffered events individually to Plausible", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedEventRequest> = [];
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          TRITONAI_PLAUSIBLE_EVENTS_ENDPOINT: "/api/event",
          TRITONAI_PLAUSIBLE_SITE_ID: "tritonai-harness-test",
        }),
      );
      const eventServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedEventRequest["body"]),
            Effect.orElseSucceed(() => null),
          );

          capturedRequests.push({
            path: request.url,
            userAgent: request.headers["user-agent"],
            body: payload,
          });

          return HttpServerResponse.empty({ status: 202 });
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(eventServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", {
            index,
            ...(index === 0
              ? {
                  nestedValueIsDropped: { private: "value" },
                  nonFiniteValueIsDropped: Number.NaN,
                }
              : {}),
          });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(capturedRequests.length, 45);
      assert.equal(
        capturedRequests.every((request) => request.path === "/api/event"),
        true,
      );
      assert.equal(
        capturedRequests.every(
          (request) => request.userAgent === `TritonAI-Harness/${packageJson.version}`,
        ),
        true,
      );

      const deliveredIndexes = capturedRequests
        .filter((request) => request.body?.name === "test.flush.drain")
        .map((request) => request.body?.props?.index)
        .filter((index): index is number => typeof index === "number");
      assert.deepEqual(
        deliveredIndexes,
        Array.from({ length: 45 }, (_, index) => index),
      );

      const firstRequest = capturedRequests[0];
      assert.isDefined(firstRequest);
      assert.equal(firstRequest?.body?.domain, "tritonai-harness-test");
      assert.equal(firstRequest?.body?.url, "https://tritonai-harness-test/");
      assert.equal(firstRequest?.body?.props?.version, packageJson.version);
      assert.equal(firstRequest?.body?.props?.clientType, "cli-web-client");
      assert.equal(typeof firstRequest?.body?.props?.platform, "string");
      assert.equal(typeof firstRequest?.body?.props?.arch, "string");
      assert.equal(firstRequest?.body?.props?.wsl, false);
      assert.notProperty(firstRequest?.body?.props ?? {}, "nestedValueIsDropped");
      assert.notProperty(firstRequest?.body?.props ?? {}, "nonFiniteValueIsDropped");
    }),
  );
});
