import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { RegistryRuntime } from "../integrations/IntegrationRegistry.ts";
import { subscribeIntegrationAvailabilityRefresh } from "./IntegrationAvailabilityRefresh.ts";
import type { ProviderRegistry } from "./ProviderRegistry.ts";
type ProviderRegistryShape = ProviderRegistry["Service"];

const snapshot = (instanceId: string, driver: string): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
  }) as ServerProvider;

describe("IntegrationAvailabilityRefresh", () => {
  it("lets healthy sibling instance refreshes settle when one instance fails", async () => {
    vi.useFakeTimers();
    try {
      const integrations = {
        subscribeAvailabilityChanges: () => () => undefined,
      } as unknown as RegistryRuntime;
      const siblingStarted = Promise.withResolvers<void>();
      const releaseSibling = Promise.withResolvers<void>();
      const siblingFinished = Promise.withResolvers<void>();
      const errorObserved = Promise.withResolvers<void>();
      let siblingCompleted = false;
      const errors: Array<unknown> = [];
      const providers = {
        getProviders: Effect.succeed([
          snapshot("codex-fails", "codex"),
          snapshot("codex-hangs", "codex"),
        ]),
        refreshInstance: (instanceId: ProviderInstanceId) =>
          instanceId === "codex-fails"
            ? Effect.promise(async () => {
                await siblingStarted.promise;
                throw new Error("temporary refresh failure");
              })
            : Effect.promise(async () => {
                siblingStarted.resolve();
                await releaseSibling.promise;
                siblingCompleted = true;
                siblingFinished.resolve();
                return [];
              }),
        refreshWorkspaceSnapshot: () => Effect.succeed([]),
        refresh: () => Effect.succeed([]),
        refreshAfterUpdate: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
        setProviderMaintenanceActionState: () => Effect.die("unused"),
        streamChanges: Stream.empty,
      } satisfies ProviderRegistryShape;

      const unsubscribe = subscribeIntegrationAvailabilityRefresh(integrations, providers, {
        debounceMs: 10,
        retryMs: 100,
        onError: (error) => {
          errors.push(error);
          errorObserved.resolve();
        },
      });
      await vi.advanceTimersByTimeAsync(10);
      await siblingStarted.promise;
      await errorObserved.promise;
      expect(errors).toHaveLength(1);
      expect(siblingCompleted).toBe(false);
      releaseSibling.resolve();
      await siblingFinished.promise;
      expect(siblingCompleted).toBe(true);

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts an older sibling refresh for a newer availability generation", async () => {
    vi.useFakeTimers();
    try {
      let observer: (() => void) | undefined;
      const integrations = {
        subscribeAvailabilityChanges: (next: () => void) => {
          observer = next;
          return () => {
            observer = undefined;
          };
        },
      } as unknown as RegistryRuntime;
      const siblingStarted = Promise.withResolvers<void>();
      const releaseSibling = Promise.withResolvers<void>();
      const errorObserved = Promise.withResolvers<void>();
      let failingAttempts = 0;
      let siblingAttempts = 0;
      const providers = {
        getProviders: Effect.succeed([
          snapshot("codex-fails", "codex"),
          snapshot("codex-sibling", "codex"),
        ]),
        refreshInstance: (instanceId: ProviderInstanceId) =>
          instanceId === "codex-fails"
            ? Effect.sync(() => {
                failingAttempts += 1;
                if (failingAttempts === 1) throw new Error("temporary refresh failure");
                return [];
              })
            : Effect.promise(async () => {
                siblingAttempts += 1;
                if (siblingAttempts === 1) {
                  siblingStarted.resolve();
                  await releaseSibling.promise;
                }
                return [];
              }),
        refreshWorkspaceSnapshot: () => Effect.succeed([]),
        refresh: () => Effect.succeed([]),
        refreshAfterUpdate: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
        setProviderMaintenanceActionState: () => Effect.die("unused"),
        streamChanges: Stream.empty,
      } satisfies ProviderRegistryShape;

      const unsubscribe = subscribeIntegrationAvailabilityRefresh(integrations, providers, {
        debounceMs: 10,
        retryMs: 100,
        onError: () => errorObserved.resolve(),
      });
      await vi.advanceTimersByTimeAsync(10);
      await siblingStarted.promise;
      await errorObserved.promise;

      observer?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(failingAttempts).toBe(2);
      expect(siblingAttempts).toBe(1);

      releaseSibling.resolve();
      await vi.waitFor(() => expect(siblingAttempts).toBe(2));
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
