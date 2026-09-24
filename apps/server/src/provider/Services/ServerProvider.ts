import type { ProviderUsageLimitsUpdate, ServerProvider } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  /**
   * Ownership-derived update capabilities. Cached between reads; pass
   * `{ fresh: true }` before executing an update so it never trusts a
   * resolution older than the click.
   */
  readonly resolveMaintenance: (options?: {
    readonly fresh?: boolean;
  }) => Effect.Effect<ProviderMaintenanceCapabilities>;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
  /** Acquire the change subscription before forking its consumer to avoid losing startup events. */
  readonly subscribeChanges?: Effect.Effect<
    PubSub.Subscription<ServerProvider>,
    never,
    Scope.Scope
  >;
  /**
   * Fold a runtime rate-limit update into the published snapshot without
   * waiting for the next status probe. Sparse: windows merge by id and an
   * update with no usable window leaves the snapshot untouched.
   */
  readonly applyUsageLimits: (
    update: ProviderUsageLimitsUpdate & { readonly checkedAt: string },
  ) => Effect.Effect<void>;
}
