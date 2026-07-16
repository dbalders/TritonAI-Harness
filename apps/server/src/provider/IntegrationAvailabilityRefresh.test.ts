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
      const errors: Array<unknown> = [];
      const providers = {
        getProviders: Effect.succeed([snapshot("codex", "codex")]),
        refreshInstance: () =>
          Effect.sync(() => {
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
