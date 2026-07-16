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
  let nextDelayMs = debounceMs;
  let currentRetryMs = retryMs;

  const schedule = (delayMs = debounceMs) => {
    if (closed || timer !== null || refreshing) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, delayMs);
  };

  const refresh = async () => {
    if (closed || refreshing) return;
    refreshing = true;
    queued = false;
    try {
      const snapshots = await Effect.runPromise(providers.getProviders);
      const instanceIds = [
        ...new Set(
          snapshots
            .filter(({ driver }) => driver === CODEX_DRIVER)
            .map(({ instanceId }) => instanceId),
        ),
      ];
      await Promise.all(
        instanceIds.map((instanceId) => Effect.runPromise(providers.refreshInstance(instanceId))),
      );
      currentRetryMs = retryMs;
      nextDelayMs = debounceMs;
    } catch (error) {
      options.onError?.(error);
      queued = true;
      nextDelayMs = currentRetryMs;
      currentRetryMs = Math.min(maxRetryMs, Math.max(retryMs, currentRetryMs * 2));
    } finally {
      refreshing = false;
      if (queued) schedule(nextDelayMs);
    }
  };

  const unsubscribe = integrations.subscribeAvailabilityChanges(() => {
    if (closed) return;
    queued = true;
    nextDelayMs = debounceMs;
    schedule();
  });
  queued = true;
  schedule();

  return () => {
    closed = true;
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
