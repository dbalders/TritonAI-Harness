/**
 * Privacy-friendly aggregate analytics delivered to Plausible.
 *
 * Buffers non-identifying product events in memory and sends them to the
 * TritonAI Plausible property over Effect's HTTP client.
 *
 * @module AnalyticsService
 */
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";

interface BufferedAnalyticsEvent {
  readonly event: string;
  readonly properties: Readonly<Record<string, PlausiblePropertyValue>>;
}

const PLAUSIBLE_EVENTS_ENDPOINT = "https://tritonai-analytics.ucsd.edu/api/event";
const PLAUSIBLE_SITE_ID = "tritonai-harness";

const PLAUSIBLE_EVENT_PROPERTIES = {
  "server.boot.heartbeat": ["threadCount", "projectCount"],
  "thread.created": ["runtimeMode", "interactionMode"],
  "provider.turn.completed": ["provider", "outcome"],
  "provider.session.recovered": ["provider", "strategy"],
  "provider.session.stopped": ["provider"],
  "provider.session.started": ["provider", "runtimeMode", "hasResumeCursor", "hasCwd"],
  "provider.turn.sent": ["provider", "interactionMode", "attachmentCount"],
  "provider.turn.interrupted": ["provider"],
  "provider.request.responded": ["provider", "decision"],
  "provider.conversation.rolled_back": ["provider", "turns"],
  "provider.sessions.stopped_all": ["sessionCount"],
} as const satisfies Readonly<Record<string, ReadonlyArray<string>>>;

const TelemetryEnvConfig = Config.all({
  plausibleEventsEndpoint: Config.string("TRITONAI_PLAUSIBLE_EVENTS_ENDPOINT").pipe(
    Config.withDefault(PLAUSIBLE_EVENTS_ENDPOINT),
  ),
  plausibleSiteId: Config.string("TRITONAI_PLAUSIBLE_SITE_ID").pipe(
    Config.withDefault(PLAUSIBLE_SITE_ID),
  ),
  enabled: Config.boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  maxBufferedEvents: Config.number("T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
});

// Plausible custom properties accept scalar strings, numbers, and booleans.
type PlausiblePropertyValue = string | number | boolean;

function toPlausibleProperties(
  event: string,
  properties: Readonly<Record<string, unknown>> | undefined,
): Record<string, PlausiblePropertyValue> | null {
  if (!Object.hasOwn(PLAUSIBLE_EVENT_PROPERTIES, event)) return null;
  const allowedKeys = PLAUSIBLE_EVENT_PROPERTIES[event as keyof typeof PLAUSIBLE_EVENT_PROPERTIES];
  if (!properties) return {};

  const sanitized: Record<string, PlausiblePropertyValue> = {};
  for (const key of allowedKeys) {
    if (!Object.hasOwn(properties, key)) continue;
    const value = properties[key];
    if (typeof value === "string" || typeof value === "boolean") {
      sanitized[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Record an anonymous event for best-effort buffered delivery. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** Flush all currently queued telemetry events. */
    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {
  /** No-op layer for callers that intentionally disable telemetry. */
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const userAgent = `TritonAI-Harness/${packageJson.version}`;
  const eventUrl = `https://${telemetryConfig.plausibleSiteId}/`;

  const enqueueBufferedEvent = (
    event: string,
    properties: Readonly<Record<string, PlausiblePropertyValue>>,
  ) =>
    Ref.modify(bufferRef, (current) => {
      const appended = [
        ...current,
        {
          event,
          properties,
        } satisfies BufferedAnalyticsEvent,
      ];

      const next =
        appended.length > telemetryConfig.maxBufferedEvents
          ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
          : appended;

      return [
        {
          size: next.length,
          dropped: next.length !== appended.length,
        } as const,
        next,
      ] as const;
    });

  const sendEvent = Effect.fn("AnalyticsService.sendEvent")(function* (
    event: BufferedAnalyticsEvent,
  ) {
    if (!telemetryConfig.enabled) return;

    const payload = {
      domain: telemetryConfig.plausibleSiteId,
      name: event.event,
      url: eventUrl,
      props: {
        ...event.properties,
        platform: hostPlatform,
        wsl: Option.isSome(telemetryConfig.wslDistroName),
        arch: hostArchitecture,
        version: packageJson.version,
        clientType,
      },
    };

    yield* HttpClientRequest.post(telemetryConfig.plausibleEventsEndpoint).pipe(
      HttpClientRequest.setHeader("user-agent", userAgent),
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  });

  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    while (true) {
      const event = yield* Ref.modify(bufferRef, (current) => {
        if (current.length === 0) {
          return [null, current] as const;
        }
        return [current[0] ?? null, current.slice(1)] as const;
      });

      if (event === null) {
        return;
      }

      yield* sendEvent(event).pipe(
        Effect.catch((error) =>
          Ref.update(bufferRef, (current) => [event, ...current]).pipe(
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      );
    }
  }).pipe(Effect.catch((cause) => Effect.logError("Failed to flush telemetry", { cause })));

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties) {
      if (!telemetryConfig.enabled) return;

      const plausibleProperties = toPlausibleProperties(event, properties);
      if (plausibleProperties === null) return;

      const enqueueResult = yield* enqueueBufferedEvent(event, plausibleProperties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  yield* Effect.forever(Effect.sleep(1000).pipe(Effect.flatMap(() => flush)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => flush);

  return AnalyticsService.of({ record, flush });
});

export const layer = Layer.effect(AnalyticsService, make);

export const layerTest = AnalyticsService.layerTest;
