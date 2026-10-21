import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect(
  "preserves thread privacy and sort position through stop, resume, archive and shell reads",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:team-sharing");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:team-sharing"),
        title: "Shared work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const initial = yield* projections.getThread(threadId);
      const setSharing = (shared: boolean, command: string) =>
        orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(command),
          threadId,
          teamSharing: shared,
        });
      yield* TestClock.adjust("1 minute");
      yield* setSharing(true, "already-shared");
      assert.equal((yield* projections.getThread(threadId)).teamSharingResumedAt, null);
      yield* setSharing(false, "stop-sharing");
      const off = yield* projections.getThread(threadId);
      assert.ok(off.teamSharingOffAt);
      assert.equal(DateTime.formatIso(off.updatedAt), DateTime.formatIso(initial.updatedAt));
      yield* TestClock.adjust("1 minute");
      yield* setSharing(false, "stop-again");
      assert.equal(
        DateTime.formatIso((yield* projections.getThread(threadId)).teamSharingOffAt!),
        DateTime.formatIso(off.teamSharingOffAt),
      );
      yield* setSharing(true, "resume-sharing");
      const resumed = yield* projections.getThread(threadId);
      assert.equal(resumed.teamSharingOffAt, null);
      assert.ok(resumed.teamSharingResumedAt);
      assert.ok(
        DateTime.toEpochMillis(resumed.teamSharingResumedAt) >
          DateTime.toEpochMillis(off.teamSharingOffAt),
      );
      const shell = yield* projections.getThreadShell(threadId);
      assert.equal(
        DateTime.formatIso(shell!.teamSharingResumedAt!),
        DateTime.formatIso(resumed.teamSharingResumedAt),
      );
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive"),
        threadId,
      });
      yield* setSharing(false, "withdraw-archived");
      const archived = yield* projections.getThread(threadId);
      assert.ok(archived.archivedAt);
      assert.ok(archived.teamSharingOffAt);
      assert.equal(
        DateTime.formatIso(archived.teamSharingResumedAt!),
        DateTime.formatIso(resumed.teamSharingResumedAt),
      );
    }).pipe(Effect.provide(layerTest)),
);
