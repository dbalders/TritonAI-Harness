import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadGoal,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const threadId = ThreadId.make("thread-goal-ordering");
const baseTime = "2026-08-17T00:00:00.000Z";

const thread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-goal-ordering"),
  title: "Goal ordering",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: baseTime,
  updatedAt: baseTime,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

function goalEvent(sequence: number, goal: ThreadGoal): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`goal-event-${sequence}`),
    type: "thread.goal-updated",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: `2026-08-17T00:00:0${sequence}.000Z`,
    commandId: CommandId.make(`goal-command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, goal },
  };
}

it.effect("does not replace provider goal state with an older delayed update", () =>
  Effect.gen(function* () {
    const currentGoal: ThreadGoal = {
      objective: "Keep the newest objective",
      status: "active",
      tokenBudget: null,
      tokensUsed: 200,
      timeUsedSeconds: 20,
      createdAt: baseTime,
      updatedAt: "2026-08-17T00:02:00.000Z",
    };
    const staleGoal: ThreadGoal = {
      ...currentGoal,
      objective: "Old objective",
      tokensUsed: 100,
      updatedAt: "2026-08-17T00:01:00.000Z",
    };
    const initial = { ...createEmptyReadModel(baseTime), threads: [thread] };
    const withCurrent = yield* projectEvent(initial, goalEvent(1, currentGoal));
    const afterStale = yield* projectEvent(withCurrent, goalEvent(2, staleGoal));

    expect(afterStale.threads[0]?.goal).toEqual(currentGoal);
    expect(afterStale.snapshotSequence).toBe(2);
  }),
);
