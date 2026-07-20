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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
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
const TELEMETRY_FLUSH_INTERVAL_MS = 30_000;
const TELEMETRY_REQUEST_TIMEOUT_MS = 5_000;
const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 5_000;
const TELEMETRY_RETRY_MAX_DELAY_MS = 5 * 60_000;

const PUBLIC_PROVIDER_VALUES = new Set(["claudeAgent", "codex", "cursor", "grok", "opencode"]);

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

function toPublicPlausibleProperty(
  key: string,
  value: unknown,
): PlausiblePropertyValue | undefined {
  if (key === "provider" && typeof value === "string") {
    return PUBLIC_PROVIDER_VALUES.has(value) ? value : "other";
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/** Equal-jitter delay keeps successful clients spread out and backs off outages. */
export function telemetryFlushDelayMs(consecutiveFailures: number, randomUnit: number): number {
  const boundedFailures = Math.max(0, Math.floor(consecutiveFailures));
  const retryExponent = Math.min(Math.max(0, boundedFailures - 1), 20);
  const ceiling =
    boundedFailures === 0
      ? TELEMETRY_FLUSH_INTERVAL_MS
      : Math.min(TELEMETRY_FLUSH_INTERVAL_MS * 2 ** retryExponent, TELEMETRY_RETRY_MAX_DELAY_MS);
  const boundedRandom = Math.min(1, Math.max(0, randomUnit));
  return Math.round(ceiling / 2 + (ceiling / 2) * boundedRandom);
}

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
    const value = toPublicPlausibleProperty(key, properties[key]);
    if (value !== undefined) sanitized[key] = value;
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

    /** Best-effort bounded flush of currently queued telemetry events. */
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

export interface AnalyticsServiceOptions {
  readonly requestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export const makeWithOptions = (options: AnalyticsServiceOptions = {}) =>
  Effect.gen(function* () {
    const telemetryConfig = yield* TelemetryEnvConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
    const deliveredEventCountRef = yield* Ref.make(0);
    const flushSemaphore = yield* Semaphore.make(1);
    const maxBufferedEvents = Math.max(0, Math.floor(telemetryConfig.maxBufferedEvents));
    const requestTimeoutMs = positiveMilliseconds(
      options.requestTimeoutMs,
      TELEMETRY_REQUEST_TIMEOUT_MS,
    );
    const shutdownTimeoutMs = positiveMilliseconds(
      options.shutdownTimeoutMs,
      TELEMETRY_SHUTDOWN_TIMEOUT_MS,
    );
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
          appended.length > maxBufferedEvents
            ? appended.slice(appended.length - maxBufferedEvents)
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
        Effect.interruptible,
        Effect.timeout(Duration.millis(requestTimeoutMs)),
      );
    });

    const requeueBufferedEvent = (event: BufferedAnalyticsEvent) =>
      Ref.update(bufferRef, (current) => {
        const restored = [event, ...current];
        return restored.length > maxBufferedEvents
          ? restored.slice(0, maxBufferedEvents)
          : restored;
      });

    const flushUnlocked = Effect.gen(function* () {
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
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : requeueBufferedEvent(event),
          ),
        );
        yield* Ref.update(deliveredEventCountRef, (count) => count + 1);
      }
    });

    const flushAttempt = Effect.gen(function* () {
      const deliveredBefore = yield* Ref.get(deliveredEventCountRef);
      const exit = yield* flushSemaphore
        .withPermit(flushUnlocked)
        .pipe(
          Effect.interruptible,
          Effect.timeout(Duration.millis(shutdownTimeoutMs)),
          Effect.result,
        );
      if (Result.isSuccess(exit)) return true;

      // A large healthy backlog can consume the scope budget after making
      // progress. Only apply outage backoff when nothing was delivered.
      const deliveredAfter = yield* Ref.get(deliveredEventCountRef);
      if (deliveredAfter > deliveredBefore) return true;

      yield* Effect.logWarning("Telemetry delivery unavailable; buffered events retained");
      return false;
    });

    const flush: AnalyticsService["Service"]["flush"] = flushAttempt.pipe(Effect.asVoid);

    const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
      function* (event, properties) {
        if (!telemetryConfig.enabled) return;

        const plausibleProperties = toPlausibleProperties(event, properties);
        if (plausibleProperties === null) return;

        const enqueueResult = yield* enqueueBufferedEvent(event, plausibleProperties);
        if (enqueueResult.dropped) {
          yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
            size: enqueueResult.size,
            incomingEvent: event,
          });
        }
      },
    );

    if (telemetryConfig.enabled) {
      yield* Effect.addFinalizer(() => flush);

      yield* Effect.gen(function* () {
        let consecutiveFailures = 0;
        while (true) {
          const randomUnit = yield* Random.next;
          yield* Effect.sleep(
            Duration.millis(telemetryFlushDelayMs(consecutiveFailures, randomUnit)),
          );
          const succeeded = yield* flushAttempt;
          consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
        }
      }).pipe(Effect.forkScoped);
    }

    return AnalyticsService.of({ record, flush });
  });

export const make = makeWithOptions();

export const layer = Layer.effect(AnalyticsService, make);

export const layerWithOptions = (options: AnalyticsServiceOptions) =>
  Layer.effect(AnalyticsService, makeWithOptions(options));

export const layerTest = AnalyticsService.layerTest;
