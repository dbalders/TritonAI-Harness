import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
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
          yield* analytics.record("server.boot.heartbeat", {
            threadCount: index,
            projectCount: index + 1,
            ...(index === 0
              ? {
                  nestedValueIsDropped: { private: "value" },
                  nonFiniteValueIsDropped: Number.NaN,
                }
              : {}),
          });
        }
        const inheritedProperties = Object.assign(
          Object.create({ provider: "private-inherited-provider" }) as Record<string, unknown>,
          { interactionMode: "full" },
        );
        yield* analytics.record("provider.turn.sent", inheritedProperties);
        yield* analytics.record("provider.turn.sent", {
          provider: "codex",
          model: "private-model-name",
          interactionMode: "plan",
          attachmentCount: 2,
        });
        yield* analytics.record("provider.turn.sent", {
          provider: "private-customer-provider",
          interactionMode: "full",
          attachmentCount: 0,
        });
        yield* analytics.record("private.unknown.event", {
          privateValue: "must not be sent",
        });
        yield* analytics.record("constructor", {
          privateValue: "must not be sent",
        });

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(capturedRequests.length, 48);
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

      const deliveredThreadCounts = capturedRequests
        .filter((request) => request.body?.name === "server.boot.heartbeat")
        .map((request) => request.body?.props?.threadCount)
        .filter((index): index is number => typeof index === "number");
      assert.deepEqual(
        deliveredThreadCounts,
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

      const inheritedPropertyRequest = capturedRequests.at(-3);
      assert.equal(inheritedPropertyRequest?.body?.name, "provider.turn.sent");
      assert.equal(inheritedPropertyRequest?.body?.props?.interactionMode, "full");
      assert.notProperty(inheritedPropertyRequest?.body?.props ?? {}, "provider");

      const turnSentRequest = capturedRequests.at(-2);
      assert.equal(turnSentRequest?.body?.name, "provider.turn.sent");
      assert.equal(turnSentRequest?.body?.props?.provider, "codex");
      assert.equal(turnSentRequest?.body?.props?.interactionMode, "plan");
      assert.equal(turnSentRequest?.body?.props?.attachmentCount, 2);
      assert.notProperty(turnSentRequest?.body?.props ?? {}, "model");

      const privateProviderRequest = capturedRequests.at(-1);
      assert.equal(privateProviderRequest?.body?.name, "provider.turn.sent");
      assert.equal(privateProviderRequest?.body?.props?.provider, "other");
    }),
  );

  it.effect("retains a buffered event after a failed flush and retries it", () =>
    Effect.gen(function* () {
      const capturedThreadCounts: Array<unknown> = [];
      let rejectRequests = true;
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-retry-",
      });
      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS: 2,
          TRITONAI_PLAUSIBLE_EVENTS_ENDPOINT: "/api/event",
          TRITONAI_PLAUSIBLE_SITE_ID: "tritonai-harness-test",
        }),
      );
      const eventServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const body = yield* request.json.pipe(
            Effect.map((value) => value as RecordedEventRequest["body"]),
            Effect.orElseSucceed(() => null),
          );
          capturedThreadCounts.push(body?.props?.threadCount);
          return HttpServerResponse.empty({ status: rejectRequests ? 503 : 202 });
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(eventServerLayer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        for (let threadCount = 1; threadCount <= 3; threadCount += 1) {
          yield* analytics.record("server.boot.heartbeat", { threadCount, projectCount: 1 });
        }

        yield* analytics.flush;
        assert.deepEqual(capturedThreadCounts, [2]);

        rejectRequests = false;
        yield* analytics.flush;
        assert.deepEqual(capturedThreadCounts, [2, 2, 3]);
      }).pipe(Effect.provide(runtimeLayer));
    }),
  );

  it.effect("retains the failed event when the buffer fills during delivery", () =>
    Effect.gen(function* () {
      const capturedThreadCounts: Array<unknown> = [];
      let markFirstRequestStarted!: () => void;
      const firstRequestStarted = new Promise<void>((resolve) => {
        markFirstRequestStarted = resolve;
      });
      let releaseFirstRequest!: () => void;
      const firstRequestCanFinish = new Promise<void>((resolve) => {
        releaseFirstRequest = resolve;
      });
      let requestCount = 0;
      const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-concurrent-retry-",
      });
      const telemetryLayer = AnalyticsService.layer.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS: 2,
          TRITONAI_PLAUSIBLE_EVENTS_ENDPOINT: "https://example.invalid/api/event",
          TRITONAI_PLAUSIBLE_SITE_ID: "tritonai-harness-test",
        }),
      );
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.promise(async () => {
            requestCount += 1;
            if (requestCount === 1) {
              markFirstRequestStarted();
              await firstRequestCanFinish;
            }
            const rawBody = (request.body as { readonly body?: Uint8Array }).body;
            assert.isDefined(rawBody);
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            const body = JSON.parse(
              new TextDecoder().decode(rawBody),
            ) as RecordedEventRequest["body"];
            capturedThreadCounts.push(body?.props?.threadCount);
            if (requestCount === 1) {
              return HttpClientResponse.fromWeb(request, new Response("", { status: 503 }));
            }
            return HttpClientResponse.fromWeb(request, new Response("", { status: 202 }));
          }),
        ),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provide(httpClientLayer),
      );

      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("server.boot.heartbeat", { threadCount: 1, projectCount: 1 });
        yield* analytics.record("server.boot.heartbeat", { threadCount: 2, projectCount: 1 });

        yield* Effect.all(
          [
            analytics.flush,
            Effect.gen(function* () {
              yield* Effect.promise(() => firstRequestStarted);
              yield* analytics.record("server.boot.heartbeat", {
                threadCount: 3,
                projectCount: 1,
              });
              releaseFirstRequest();
            }),
          ],
          { concurrency: "unbounded" },
        );

        yield* analytics.flush;
        assert.deepEqual(capturedThreadCounts, [1, 1, 2]);
      }).pipe(Effect.provide(runtimeLayer));
    }),
  );

  it("uses jittered exponential backoff with a five-minute ceiling", () => {
    assert.equal(AnalyticsService.telemetryFlushDelayMs(0, 0), 15_000);
    assert.equal(AnalyticsService.telemetryFlushDelayMs(0, 1), 30_000);
    assert.equal(AnalyticsService.telemetryFlushDelayMs(1, 0), 15_000);
    assert.equal(AnalyticsService.telemetryFlushDelayMs(2, 1), 60_000);
    assert.equal(AnalyticsService.telemetryFlushDelayMs(20, 1), 300_000);
  });
});

it.live("finalizes promptly when the analytics endpoint hangs", () =>
  Effect.gen(function* () {
    let requestStarted = false;
    const hangingHttpClientLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() =>
        Effect.sync(() => {
          requestStarted = true;
        }).pipe(Effect.andThen(Effect.never)),
      ),
    );
    const serverConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-telemetry-hang-",
    });
    const telemetryLayer = AnalyticsService.layerWithOptions({
      requestTimeoutMs: 25,
      shutdownTimeoutMs: 75,
    }).pipe(Layer.provideMerge(serverConfigLayer));
    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        T3CODE_TELEMETRY_ENABLED: true,
        TRITONAI_PLAUSIBLE_EVENTS_ENDPOINT: "https://example.invalid/api/event",
        TRITONAI_PLAUSIBLE_SITE_ID: "tritonai-harness-test",
      }),
    );
    const runtimeLayer = telemetryLayer.pipe(
      Layer.provide(configLayer),
      Layer.provide(hangingHttpClientLayer),
    );

    const serviceScope = yield* Scope.make("sequential");
    const services = yield* Layer.build(runtimeLayer).pipe(Scope.provide(serviceScope));
    const analytics = yield* AnalyticsService.AnalyticsService.pipe(Effect.provide(services));
    yield* analytics.record("provider.turn.completed", {
      provider: "codex",
      outcome: "completed",
    });

    yield* Scope.close(serviceScope, Exit.void).pipe(Effect.timeout("500 millis"));
    assert.isTrue(requestStarted);
  }).pipe(Effect.provide(NodeServices.layer)),
);
