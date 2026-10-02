import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderUpdateError,
  ThreadId,
  type ProviderSession,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ManagedCodexAutoUpdate from "./managedCodexAutoUpdate.ts";
import { makeProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import {
  ProviderMaintenanceRunner,
  type ProviderMaintenanceRunnerShape,
} from "./providerMaintenanceRunner.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "./Services/ProviderRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "./Services/ProviderService.ts";

const CODEX = ProviderDriverKind.make("codex");
const CURSOR = ProviderDriverKind.make("cursor");
const CODEX_ID = ProviderInstanceId.make("codex");
const CODEX_WORK_ID = ProviderInstanceId.make("codex_work");
const CODEX_PERSONAL_ID = ProviderInstanceId.make("codex_personal");
const CURSOR_ID = ProviderInstanceId.make("cursor");
const APPROVED = "0.151.0";
const CHECKED_AT = "2026-09-30T00:00:00.000Z";

function snapshot(
  overrides: Partial<ServerProvider> & {
    readonly advisory?: Partial<NonNullable<ServerProvider["versionAdvisory"]>>;
  } = {},
): ServerProvider {
  const { advisory, ...rest } = overrides;
  return {
    instanceId: CODEX_ID,
    driver: CODEX,
    enabled: true,
    installed: true,
    version: "0.150.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: CHECKED_AT,
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "0.150.0",
      latestVersion: APPROVED,
      updateCommand: "node server.js managed-codex-update codex",
      canUpdate: true,
      checkedAt: CHECKED_AT,
      message: "Install the update now or review provider settings.",
      ...advisory,
    },
    ...rest,
  };
}

const managedCapabilities = (provider: ProviderDriverKind) => ({
  ...makeProviderMaintenanceCapabilities({
    provider,
    packageName: "@openai/codex",
    updateExecutable: "node",
    updateArgs: ["server.js", "managed-codex-update", "codex"],
    updateLockKey: "tritonai-managed-codex",
  }),
  approvedVersion: APPROVED,
});

const npmCapabilities = (provider: ProviderDriverKind) =>
  makeProviderMaintenanceCapabilities({
    provider,
    packageName: "@openai/codex",
    updateExecutable: "npm",
    updateArgs: ["install", "-g", "@openai/codex@latest"],
    updateLockKey: "npm-global",
  });

function codexSession(threadId: string): ProviderSession {
  return {
    provider: CODEX,
    providerInstanceId: CODEX_ID,
    status: "ready",
    runtimeMode: "full-access",
    threadId: ThreadId.make(threadId),
    createdAt: CHECKED_AT,
    updatedAt: CHECKED_AT,
  };
}

const makeHarness = Effect.fn("makeHarness")(function* (input: {
  readonly initialProviders?: ReadonlyArray<ServerProvider>;
  readonly unmanagedInstanceIds?: ReadonlyArray<ProviderInstanceId>;
  readonly rejectedInstanceId?: ProviderInstanceId;
}) {
  const providersRef = yield* Ref.make(input.initialProviders ?? []);
  const sessionsRef = yield* Ref.make<ReadonlyArray<ProviderSession>>([]);
  const updateCallsRef = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
  const updated = yield* PubSub.unbounded<ProviderInstanceId>();
  const updatedSubscription = yield* PubSub.subscribe(updated);
  const changes = yield* PubSub.unbounded<ReadonlyArray<ServerProvider>>();
  const subscribed = yield* Deferred.make<void>();
  const unmanaged = new Set(input.unmanagedInstanceIds ?? []);

  const registry: Partial<ProviderRegistryShape> = {
    getProviders: Ref.get(providersRef),
    getProviderMaintenanceCapabilitiesForInstance: (instanceId, provider) =>
      Effect.succeed(
        unmanaged.has(instanceId) ? npmCapabilities(provider) : managedCapabilities(provider),
      ),
    streamChanges: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        yield* Deferred.succeed(subscribed, undefined);
        return Stream.fromSubscription(subscription);
      }),
    ),
  };
  const runner: ProviderMaintenanceRunnerShape = {
    updateProvider: (target) =>
      Effect.gen(function* () {
        const instanceId = typeof target === "string" ? CODEX_ID : (target.instanceId ?? CODEX_ID);
        yield* Ref.update(updateCallsRef, (calls) => [...calls, instanceId]);
        yield* PubSub.publish(updated, instanceId);
        if (instanceId === input.rejectedInstanceId) {
          return yield* new ServerProviderUpdateError({
            provider: CODEX,
            reason: "An update is already running for this provider.",
          });
        }
        return {
          providers: [
            snapshot({
              instanceId,
              updateState: {
                status: "failed",
                startedAt: CHECKED_AT,
                finishedAt: CHECKED_AT,
                message: "The managed Codex update was rolled back.",
                output: null,
              },
            }),
          ],
        };
      }),
  };
  const providerService: Partial<ProviderServiceShape> = {
    listSessions: () => Ref.get(sessionsRef),
  };

  const services = Layer.mergeAll(
    Layer.mock(ProviderRegistry)(registry),
    Layer.succeed(ProviderMaintenanceRunner, runner),
    Layer.mock(ProviderService)(providerService),
  );

  return {
    services,
    sessionsRef,
    updateCalls: Ref.get(updateCallsRef),
    nextUpdate: PubSub.take(updatedSubscription),
    publish: (providers: ReadonlyArray<ServerProvider>) =>
      Deferred.await(subscribed).pipe(Effect.andThen(PubSub.publish(changes, providers))),
  };
});

describe("isManagedCodexAutoUpdateCandidate", () => {
  it("accepts an enabled Codex instance behind the approved version", () => {
    assert.isTrue(ManagedCodexAutoUpdate.isManagedCodexAutoUpdateCandidate(snapshot()));
  });

  it("rejects snapshots that cannot or need not update automatically", () => {
    const rejected: ReadonlyArray<ServerProvider> = [
      snapshot({ driver: CURSOR, instanceId: CURSOR_ID }),
      snapshot({ enabled: false }),
      snapshot({ installed: false }),
      snapshot({ advisory: { status: "current" } }),
      snapshot({ advisory: { status: "unknown", latestVersion: null } }),
      snapshot({ advisory: { canUpdate: false, updateCommand: null } }),
      snapshot({ advisory: { latestVersion: null } }),
      snapshot({
        updateState: {
          status: "running",
          startedAt: CHECKED_AT,
          finishedAt: null,
          message: "Updating provider.",
          output: null,
        },
      }),
      snapshot({
        updateState: {
          status: "failed",
          startedAt: CHECKED_AT,
          finishedAt: CHECKED_AT,
          message: "Update command failed.",
          output: null,
        },
      }),
    ];
    for (const provider of rejected) {
      assert.isFalse(ManagedCodexAutoUpdate.isManagedCodexAutoUpdateCandidate(provider));
    }
    const { versionAdvisory: _versionAdvisory, ...withoutAdvisory } = snapshot();
    assert.isFalse(ManagedCodexAutoUpdate.isManagedCodexAutoUpdateCandidate(withoutAdvisory));
  });
});

describe("makeManagedCodexAutoUpdater", () => {
  it.effect("updates a managed Codex instance once per approved version", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      const { considerProviders } =
        yield* ManagedCodexAutoUpdate.makeManagedCodexAutoUpdater().pipe(
          Effect.provide(harness.services),
        );

      assert.deepStrictEqual(yield* considerProviders([snapshot()]), [CODEX_ID]);
      // The failed attempt clears its state later; the same version is never retried.
      assert.deepStrictEqual(yield* considerProviders([snapshot()]), []);
      assert.deepStrictEqual(yield* harness.updateCalls, [CODEX_ID]);
    }),
  );

  it.effect("never updates other providers or Codex instances Harness does not manage", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ unmanagedInstanceIds: [CODEX_PERSONAL_ID] });
      const { considerProviders } =
        yield* ManagedCodexAutoUpdate.makeManagedCodexAutoUpdater().pipe(
          Effect.provide(harness.services),
        );

      const attempted = yield* considerProviders([
        snapshot({ instanceId: CODEX_PERSONAL_ID, advisory: { latestVersion: "0.152.0" } }),
        snapshot({ driver: CURSOR, instanceId: CURSOR_ID }),
        // A managed runtime whose advisory does not name the approved version.
        snapshot({ advisory: { latestVersion: "0.152.0" } }),
      ]);

      assert.deepStrictEqual(attempted, []);
      assert.deepStrictEqual(yield* harness.updateCalls, []);
    }),
  );

  it.effect("leaves the update to the user while a Codex session is live", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      const { considerProviders } =
        yield* ManagedCodexAutoUpdate.makeManagedCodexAutoUpdater().pipe(
          Effect.provide(harness.services),
        );
      yield* Ref.set(harness.sessionsRef, [codexSession("thread-1")]);

      assert.deepStrictEqual(yield* considerProviders([snapshot()]), []);
      yield* Ref.set(harness.sessionsRef, []);
      assert.deepStrictEqual(yield* considerProviders([snapshot()]), []);
      assert.deepStrictEqual(yield* harness.updateCalls, []);
    }),
  );

  it.effect("keeps watching after the runner rejects an update", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ rejectedInstanceId: CODEX_ID });
      const { considerProviders } =
        yield* ManagedCodexAutoUpdate.makeManagedCodexAutoUpdater().pipe(
          Effect.provide(harness.services),
        );

      assert.deepStrictEqual(
        yield* considerProviders([snapshot(), snapshot({ instanceId: CODEX_WORK_ID })]),
        [CODEX_WORK_ID],
      );
      assert.deepStrictEqual(yield* considerProviders([snapshot()]), []);
      assert.deepStrictEqual(yield* harness.updateCalls, [CODEX_ID, CODEX_WORK_ID]);
    }),
  );
});

describe("ManagedCodexAutoUpdate.layer", () => {
  it.effect("waits for the advisory to arrive on the provider stream", () =>
    Effect.gen(function* () {
      const pending = snapshot({ advisory: { status: "unknown", latestVersion: null } });
      const harness = yield* makeHarness({ initialProviders: [pending] });
      yield* Layer.build(ManagedCodexAutoUpdate.layer.pipe(Layer.provide(harness.services)));

      yield* harness.publish([snapshot()]);
      assert.strictEqual(yield* harness.nextUpdate, CODEX_ID);

      // Changes are handled in order, so the second instance's update proves
      // the repeated snapshot for the first one was seen and skipped.
      yield* harness.publish([snapshot()]);
      yield* harness.publish([snapshot(), snapshot({ instanceId: CODEX_WORK_ID })]);
      assert.strictEqual(yield* harness.nextUpdate, CODEX_WORK_ID);
      assert.deepStrictEqual(yield* harness.updateCalls, [CODEX_ID, CODEX_WORK_ID]);
    }),
  );
});
