import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { isTritonAiManagedCodexMaintenanceCapabilities } from "./managedCodexUpdate.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { ProviderService } from "./Services/ProviderService.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

/**
 * Snapshot-only half of the auto-update decision: an enabled Codex instance
 * whose advisory offers a one-click update and that has not seen an update
 * attempt in this process. Managed ownership is checked separately because it
 * comes from the instance's maintenance capabilities, not the snapshot.
 */
export function isManagedCodexAutoUpdateCandidate(provider: ServerProvider): boolean {
  const advisory = provider.versionAdvisory;
  return (
    provider.driver === CODEX_DRIVER &&
    provider.enabled &&
    provider.installed &&
    (provider.updateState === undefined || provider.updateState.status === "idle") &&
    advisory?.status === "behind_latest" &&
    advisory.canUpdate &&
    advisory.updateCommand !== null &&
    advisory.latestVersion !== null
  );
}

/**
 * Tries each TritonAI-managed Codex instance's engine update once per approved
 * version for the life of this process. Runs through the shared
 * `ProviderMaintenanceRunner`, so clients see the usual `updateState`, manual
 * updates of the same instance are rejected while it runs, and a failure leaves
 * the manual update action in place.
 */
export const makeManagedCodexAutoUpdater = Effect.fn("makeManagedCodexAutoUpdater")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const providerMaintenanceRunner = yield* ProviderMaintenanceRunner;
  const providerService = yield* ProviderService;
  const decidedKeysRef = yield* Ref.make<ReadonlySet<string>>(new Set());

  const considerProvider = Effect.fn("ManagedCodexAutoUpdate.considerProvider")(function* (
    provider: ServerProvider,
  ) {
    if (!isManagedCodexAutoUpdateCandidate(provider)) return false;
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      provider.instanceId,
      provider.driver,
    );
    const approvedVersion = capabilities.approvedVersion;
    if (
      !isTritonAiManagedCodexMaintenanceCapabilities(capabilities) ||
      !approvedVersion ||
      approvedVersion !== provider.versionAdvisory?.latestVersion
    ) {
      return false;
    }

    const key = `${provider.instanceId}@${approvedVersion}`;
    const claimed = yield* Ref.modify(decidedKeysRef, (decided) =>
      decided.has(key) ? [false, decided] : [true, new Set(decided).add(key)],
    );
    if (!claimed) return false;

    const logContext = {
      instanceId: provider.instanceId,
      installedVersion: provider.version,
      approvedVersion,
    };
    // Swapping the engine under a live Codex process can break it (Windows
    // locks the files outright), so defer to the manual action instead.
    const liveCodexSessions = (yield* providerService.listSessions()).filter(
      (session) => session.provider === CODEX_DRIVER,
    );
    if (liveCodexSessions.length > 0) {
      yield* Effect.logInfo("Skipped automatic managed Codex update while Codex sessions run", {
        ...logContext,
        liveSessionCount: liveCodexSessions.length,
      });
      return false;
    }

    yield* Effect.logInfo("Starting automatic managed Codex update", logContext);
    const result = yield* providerMaintenanceRunner.updateProvider({
      provider: provider.driver,
      instanceId: provider.instanceId,
    });
    const updateState = result.providers.find(
      (candidate) => candidate.instanceId === provider.instanceId,
    )?.updateState;
    if (updateState?.status === "succeeded") {
      yield* Effect.logInfo("Automatic managed Codex update succeeded", logContext);
    } else {
      yield* Effect.logWarning("Automatic managed Codex update did not complete", {
        ...logContext,
        status: updateState?.status ?? null,
        message: updateState?.message ?? null,
        output: updateState?.output ?? null,
      });
    }
    return true;
  });

  /** Evaluates one provider list; resolves with the instances whose update ran. */
  const considerProviders = Effect.fn("ManagedCodexAutoUpdate.considerProviders")(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    const attempted = yield* Effect.forEach(providers, (provider) =>
      considerProvider(provider).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Automatic managed Codex update failed", {
            instanceId: provider.instanceId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
        Effect.map((ran) => (ran ? [provider.instanceId] : [])),
      ),
    );
    return attempted.flat();
  });

  return { considerProviders };
});

/**
 * Watches provider snapshots after activation, so a standby server never swaps
 * the engine under the server it may replace. Updates run one at a time.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const { considerProviders } = yield* makeManagedCodexAutoUpdater();
    yield* forkParked(
      Stream.concat(
        Stream.fromEffect(providerRegistry.getProviders),
        providerRegistry.streamChanges,
      ).pipe(Stream.runForEach(considerProviders)),
    );
  }),
);
