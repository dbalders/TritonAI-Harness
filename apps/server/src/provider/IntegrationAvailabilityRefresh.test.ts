import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { RegistryRuntime } from "../integrations/IntegrationRegistry.ts";
import { subscribeIntegrationAvailabilityRefresh } from "./IntegrationAvailabilityRefresh.ts";
import type { ProviderRegistryShape } from "./Services/ProviderRegistry.ts";

const snapshot = (instanceId: string, driver: string): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
  }) as ServerProvider;

describe("IntegrationAvailabilityRefresh", () => {
  it("retries a transient snapshot refresh failure with capped backoff", async () => {
    vi.useFakeTimers();
    try {
      const integrations = {
        subscribeAvailabilityChanges: () => () => undefined,
      } as unknown as RegistryRuntime;
      let attempts = 0;
      let failOnErrorRequested = false;
      const errors: Array<unknown> = [];
      const providers = {
        getProviders: Effect.succeed([snapshot("codex", "codex")]),
        refreshInstance: (_instanceId, options) =>
          Effect.sync(() => {
            failOnErrorRequested = options?.failOnError === true;
            attempts += 1;
            if (attempts === 1) throw new Error("temporary refresh failure");
            return [];
          }),
        refresh: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
        setProviderMaintenanceActionState: () => Effect.die("unused"),
        streamChanges: Stream.empty,
      } satisfies ProviderRegistryShape;

      const unsubscribe = subscribeIntegrationAvailabilityRefresh(integrations, providers, {
        debounceMs: 10,
        retryMs: 20,
        maxRetryMs: 40,
        onError: (error) => errors.push(error),
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toBe(1);
      expect(failOnErrorRequested).toBe(true);
      expect(errors).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(19);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a queued availability change before retry backoff after a failed refresh", async () => {
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
      const firstRefresh = Promise.withResolvers<void>();
      let attempts = 0;
      const providers = {
        getProviders: Effect.succeed([snapshot("codex", "codex")]),
        refreshInstance: () =>
          Effect.promise(async () => {
            attempts += 1;
            if (attempts === 1) await firstRefresh.promise;
            return [];
          }),
        refresh: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
        setProviderMaintenanceActionState: () => Effect.die("unused"),
        streamChanges: Stream.empty,
      } satisfies ProviderRegistryShape;

      const unsubscribe = subscribeIntegrationAvailabilityRefresh(integrations, providers, {
        debounceMs: 10,
        retryMs: 100,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toBe(1);

      observer?.();
      firstRefresh.reject(new Error("temporary refresh failure"));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(9);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);

      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts an in-flight provider refresh when unsubscribed", async () => {
    vi.useFakeTimers();
    try {
      const integrations = {
        subscribeAvailabilityChanges: () => () => undefined,
      } as unknown as RegistryRuntime;
      let attempts = 0;
      let interruptions = 0;
      const providers = {
        getProviders: Effect.succeed([snapshot("codex", "codex")]),
        refreshInstance: () =>
          Effect.sync(() => (attempts += 1)).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => (interruptions += 1))),
          ),
        refresh: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
        setProviderMaintenanceActionState: () => Effect.die("unused"),
        streamChanges: Stream.empty,
      } satisfies ProviderRegistryShape;

      const unsubscribe = subscribeIntegrationAvailabilityRefresh(integrations, providers, {
        debounceMs: 10,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toBe(1);

      unsubscribe();
      await Promise.resolve();
      expect(interruptions).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

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
        refresh: () => Effect.succeed([]),
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
        refresh: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
        setProviderMaintenanceActionState: () => Effect.die("unused"),
        streamChanges: Stream.empty,
      } satisfies ProviderRegistryShape;

      const unsubscribe = subscribeIntegrationAvailabilityRefresh(integrations, providers, {
        debounceMs: 10,
        retryMs: 10,
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

  it("refreshes existing Codex snapshots when the registry is attached", async () => {
    vi.useFakeTimers();
    try {
      const integrations = {
        subscribeAvailabilityChanges: () => () => undefined,
      } as unknown as RegistryRuntime;
      const refreshed: Array<string> = [];
      const providers = {
        getProviders: Effect.succeed([snapshot("codex", "codex")]),
        refreshInstance: (instanceId: ProviderInstanceId) =>
          Effect.sync(() => {
            refreshed.push(instanceId);
            return [];
          }),
        refresh: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
        setProviderMaintenanceActionState: () => Effect.die("unused"),
        streamChanges: Stream.empty,
      } satisfies ProviderRegistryShape;

      const unsubscribe = subscribeIntegrationAvailabilityRefresh(integrations, providers, {
        debounceMs: 25,
      });
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();

      expect(refreshed).toEqual(["codex"]);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces bursts and refreshes picker skills for every Codex instance", async () => {
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
      const refreshed: Array<string> = [];
      const refreshedSkills = new Map<string, ReadonlyArray<string>>();
      let skillAvailable = false;
      const providers = {
        getProviders: Effect.succeed([
          snapshot("codex", "codex"),
          snapshot("codex-work", "codex"),
          snapshot("claude", "claude-agent"),
        ]),
        refreshInstance: (instanceId: ProviderInstanceId) =>
          Effect.sync(() => {
            refreshed.push(instanceId);
            refreshedSkills.set(instanceId, skillAvailable ? ["microsoft-365-read"] : []);
            return [];
          }),
        refresh: () => Effect.succeed([]),
        getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
        setProviderMaintenanceActionState: () => Effect.die("unused"),
        streamChanges: Stream.empty,
      } satisfies ProviderRegistryShape;

      const unsubscribe = subscribeIntegrationAvailabilityRefresh(integrations, providers, {
        debounceMs: 25,
      });
      skillAvailable = true;
      observer?.();
      observer?.();
      observer?.();
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();

      expect(refreshed.toSorted()).toEqual(["codex", "codex-work"]);
      expect(refreshedSkills.get("codex")).toEqual(["microsoft-365-read"]);
      expect(refreshedSkills.get("codex-work")).toEqual(["microsoft-365-read"]);

      refreshed.length = 0;
      skillAvailable = false;
      observer?.();
      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();
      expect(refreshed.toSorted()).toEqual(["codex", "codex-work"]);
      expect(refreshedSkills.get("codex")).toEqual([]);
      expect(refreshedSkills.get("codex-work")).toEqual([]);
      unsubscribe();
      expect(observer).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
