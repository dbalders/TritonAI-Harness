// @effect-diagnostics globalTimers:off
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { RegistryRuntime } from "../integrations/IntegrationRegistry.ts";
import type { ProviderRegistryShape } from "./Services/ProviderRegistry.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

export interface IntegrationAvailabilityRefreshOptions {
  readonly debounceMs?: number;
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Bridge effective integration availability into every configured Codex snapshot.
 *
 * The integration registry has already compared the stable effective skill/tool set before
 * notifying us, so pending device-code polls and status-only changes never reach this coordinator.
 */
export function subscribeIntegrationAvailabilityRefresh(
  integrations: RegistryRuntime,
  providers: ProviderRegistryShape,
  options: IntegrationAvailabilityRefreshOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 100;
  const retryMs = options.retryMs ?? 500;
  const maxRetryMs = options.maxRetryMs ?? 5_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;
  let queued = false;
  let closed = false;
  let activeSnapshotRefresh: AbortController | null = null;
  const inFlightInstanceRefreshes = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly generation: number;
      readonly promise: Promise<unknown>;
    }
  >();
  let requestedGeneration = 1;
  let nextDelayMs = debounceMs;
  let currentRetryMs = retryMs;

  const schedule = (delayMs = debounceMs) => {
    if (closed || timer !== null || refreshing) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, delayMs);
  };

  const refreshInstance = (
    instanceId: Parameters<ProviderRegistryShape["refreshInstance"]>[0],
    generation: number,
  ): Promise<unknown> => {
    const existing = inFlightInstanceRefreshes.get(instanceId);
    if (existing) {
      if (existing.generation >= generation) return existing.promise;
      return existing.promise.then(
        () => (closed ? undefined : refreshInstance(instanceId, generation)),
        () => (closed ? undefined : refreshInstance(instanceId, generation)),
      );
    }
    const controller = new AbortController();
    const promise = Effect.runPromise(
      providers.refreshInstance(instanceId, { failOnError: true }),
      { signal: controller.signal },
    );
    const entry = { controller, generation, promise };
    inFlightInstanceRefreshes.set(instanceId, entry);
    const remove = () => {
      if (inFlightInstanceRefreshes.get(instanceId) === entry) {
        inFlightInstanceRefreshes.delete(instanceId);
      }
    };
    void promise.then(remove, remove);
    return promise;
  };

  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    queued = false;
    const refreshGeneration = requestedGeneration;
    const controller = new AbortController();
    activeSnapshotRefresh = controller;
    try {
      const snapshots = await Effect.runPromise(providers.getProviders, {
        signal: controller.signal,
      });
      const instanceIds = [
        ...new Set(
          snapshots
            .filter(({ driver }) => driver === CODEX_DRIVER)
            .map(({ instanceId }) => instanceId),
        ),
      ];
      await Promise.all(
        instanceIds.map((instanceId) => refreshInstance(instanceId, refreshGeneration)),
      );
      currentRetryMs = retryMs;
      nextDelayMs = debounceMs;
    } catch (error) {
      if (closed || controller.signal.aborted) return;
      options.onError?.(error);
      if (!queued) nextDelayMs = currentRetryMs;
      queued = true;
      currentRetryMs = Math.min(maxRetryMs, Math.max(retryMs, currentRetryMs * 2));
    } finally {
      if (activeSnapshotRefresh === controller) activeSnapshotRefresh = null;
      refreshing = false;
      if (queued) schedule(nextDelayMs);
    }
  };

  const unsubscribe = integrations.subscribeAvailabilityChanges(() => {
    if (closed) return;
    requestedGeneration += 1;
    queued = true;
    nextDelayMs = debounceMs;
    schedule();
  });
  queued = true;
  schedule();

  return () => {
    closed = true;
    unsubscribe();
    activeSnapshotRefresh?.abort();
    activeSnapshotRefresh = null;
    for (const { controller } of inFlightInstanceRefreshes.values()) controller.abort();
    inFlightInstanceRefreshes.clear();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
