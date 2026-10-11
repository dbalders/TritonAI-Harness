import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const OFF_AT = "2025-12-30T00:00:00.000Z";

function readModel(input: {
  readonly teamSharingOffAt?: string | null;
  readonly archivedAt?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        teamSharingOffAt: input.teamSharingOffAt ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const decide = (shared: boolean, model: OrchestrationReadModel) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.team-sharing.set",
      commandId: CommandId.make(`cmd-${shared}`),
      threadId: ThreadId.make("thread-1"),
      shared,
    },
    readModel: model,
  }).pipe(Effect.map((result) => (Array.isArray(result) ? result[0] : result)));

const event = (sequence: number, type: OrchestrationEvent["type"], payload: unknown) =>
  ({
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: NOW,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: payload as never,
  }) as OrchestrationEvent;

it.layer(NodeServices.layer)("thread.team-sharing.set", (it) => {
  it.effect("Don't share stamps the thread once and Share clears it, without reordering it", () =>
    Effect.gen(function* () {
      const off = yield* decide(false, readModel({}));
      expect(off?.type).toBe("thread.team-sharing-set");
      if (off?.type !== "thread.team-sharing-set") return;
      expect(off.payload.teamSharingOffAt).not.toBeNull();
      expect(off.payload).not.toHaveProperty("updatedAt");

      const again = yield* decide(false, readModel({ teamSharingOffAt: OFF_AT }));
      if (again?.type === "thread.team-sharing-set")
        expect(again.payload.teamSharingOffAt).toBe(OFF_AT);

      const on = yield* decide(true, readModel({ teamSharingOffAt: OFF_AT }));
      if (on?.type === "thread.team-sharing-set") expect(on.payload.teamSharingOffAt).toBeNull();
    }),
  );

  it.effect("can leave out an archived thread, which may still be in team memory", () =>
    Effect.gen(function* () {
      const off = yield* decide(false, readModel({ archivedAt: NOW }));
      expect(off?.type).toBe("thread.team-sharing-set");
    }),
  );

  it.effect("projects the choice onto the thread and keeps its updatedAt", () =>
    Effect.gen(function* () {
      const created = yield* projectEvent(
        createEmptyReadModel(NOW),
        event(1, "thread.created", {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      expect(created.threads[0]?.teamSharingOffAt).toBeNull();
      const off = yield* projectEvent(
        created,
        event(2, "thread.team-sharing-set", {
          threadId: ThreadId.make("thread-1"),
          teamSharingOffAt: OFF_AT,
        }),
      );
      expect(off.threads[0]).toMatchObject({ teamSharingOffAt: OFF_AT, updatedAt: NOW });
      const on = yield* projectEvent(
        off,
        event(3, "thread.team-sharing-set", {
          threadId: ThreadId.make("thread-1"),
          teamSharingOffAt: null,
        }),
      );
      expect(on.threads[0]?.teamSharingOffAt).toBeNull();
    }),
  );
});
