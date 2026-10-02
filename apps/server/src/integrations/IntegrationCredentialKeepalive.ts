import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { getIntegrationRegistryOptional } from "./IntegrationRegistry.ts";
import { forkParked } from "../serverActivation.ts";

/**
 * Remote OAuth grants renew only inside `prepare`, which the registry runs on tool invocation.
 * An integration nobody calls therefore never rotates its credential, and a provider whose
 * refresh token has a finite life expires on that silence: n8n drops a refresh token 30 days
 * after its last rotation, sending the user back through a browser sign-in for no reason other
 * than disuse. This sweep touches idle connections so the window keeps rolling.
 */
const DEFAULT_IDLE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Long enough that the sweep never competes with startup or a still-connecting network, short
// enough that a session shorter than the sweep interval still rolls its grants once.
const DEFAULT_INITIAL_DELAY_MS = 15 * 60 * 1000;

export interface IntegrationCredentialKeepaliveShape {
  /** Start the background credential keepalive within the provided scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class IntegrationCredentialKeepalive extends Context.Service<
  IntegrationCredentialKeepalive,
  IntegrationCredentialKeepaliveShape
>()("t3/integrations/IntegrationCredentialKeepalive") {}

export interface IntegrationCredentialKeepaliveLiveOptions {
  readonly idleThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly initialDelayMs?: number;
}

const makeIntegrationCredentialKeepalive = (options?: IntegrationCredentialKeepaliveLiveOptions) =>
  Effect.sync(() => {
    const idleThresholdMs = Math.max(1, options?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS);
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const initialDelayMs = Math.max(0, options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);

    const sweep = Effect.gen(function* () {
      // The registry starts before the reactors, but a sweep must never be the thing that
      // demands it: a missing registry simply means there is nothing to keep alive yet.
      const registry = getIntegrationRegistryOptional();
      if (!registry) return;

      const refreshed = yield* Effect.promise((signal) =>
        registry.refreshIdleCredentials({ idleThresholdMs, signal }),
      );

      if (refreshed.length > 0) {
        yield* Effect.logInfo("integrations.credential.keepalive.refreshed", {
          integrationIds: refreshed,
          idleThresholdMs,
        });
      }
    });

    const start: IntegrationCredentialKeepaliveShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("integrations.credential.keepalive.sweep-failed", { defect }),
            ),
            // The sweep runs outside any span; its logs reach the trace file only inside one.
            Effect.withSpan("integrations.credential.keepalive.sweep"),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
            Effect.delay(Duration.millis(initialDelayMs)),
          ),
        );

        yield* Effect.logInfo("integrations.credential.keepalive.started", {
          idleThresholdMs,
          sweepIntervalMs,
          initialDelayMs,
        });
      });

    return { start } satisfies IntegrationCredentialKeepaliveShape;
  });

const makeIntegrationCredentialKeepaliveLive = (
  options?: IntegrationCredentialKeepaliveLiveOptions,
) => Layer.effect(IntegrationCredentialKeepalive, makeIntegrationCredentialKeepalive(options));

export const IntegrationCredentialKeepaliveLive = makeIntegrationCredentialKeepaliveLive();
