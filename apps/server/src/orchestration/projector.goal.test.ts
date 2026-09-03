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

function clearEvent(sequence: number, occurredAt: string): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`goal-clear-event-${sequence}`),
    type: "thread.goal-cleared",
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt,
    commandId: CommandId.make(`goal-clear-command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId },
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

it.effect("keeps goal clears and replacements ordered by provider revision", () =>
  Effect.gen(function* () {
    const currentGoal: ThreadGoal = {
      objective: "Current goal",
      status: "active",
      tokenBudget: null,
      tokensUsed: 200,
      timeUsedSeconds: 20,
      createdAt: baseTime,
      updatedAt: "2026-08-17T00:02:00.000Z",
    };
    const replacementGoal: ThreadGoal = {
      ...currentGoal,
      objective: "Replacement goal",
      updatedAt: "2026-08-17T00:04:00.000Z",
    };
    const initial = { ...createEmptyReadModel(baseTime), threads: [thread] };
    const withCurrent = yield* projectEvent(initial, goalEvent(1, currentGoal));

    const afterStaleClear = yield* projectEvent(
      withCurrent,
      clearEvent(2, "2026-08-17T00:01:30.000Z"),
    );
    expect(afterStaleClear.threads[0]?.goal).toEqual(currentGoal);

    const cleared = yield* projectEvent(afterStaleClear, clearEvent(3, "2026-08-17T00:03:00.000Z"));
    expect(cleared.threads[0]?.goal).toBeUndefined();
    expect(cleared.threads[0]?.goalRevisionAt).toBe("2026-08-17T00:03:00.000Z");
    expect(cleared.threads[0]?.goalRevisionSequence).toBe(3);

    const delayedGoal: ThreadGoal = {
      ...currentGoal,
      objective: "Delayed pre-clear goal",
      updatedAt: "2026-08-17T00:02:30.000Z",
    };
    const afterDelayedUpdate = yield* projectEvent(cleared, goalEvent(4, delayedGoal));
    expect(afterDelayedUpdate.threads[0]?.goal).toBeUndefined();

    const replaced = yield* projectEvent(afterDelayedUpdate, goalEvent(5, replacementGoal));
    expect(replaced.threads[0]?.goal).toEqual(replacementGoal);

    const afterDelayedClear = yield* projectEvent(
      replaced,
      clearEvent(6, "2026-08-17T00:03:30.000Z"),
    );
    expect(afterDelayedClear.threads[0]?.goal).toEqual(replacementGoal);
  }),
);

it.effect("accepts a new goal created later in the same second as a clear", () =>
  Effect.gen(function* () {
    const currentGoal: ThreadGoal = {
      objective: "Current goal",
      status: "active",
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 5,
      createdAt: baseTime,
      updatedAt: "2026-08-17T00:02:59.000Z",
    };
    const replacementGoal: ThreadGoal = {
      ...currentGoal,
      objective: "Same-second replacement",
      updatedAt: "2026-08-17T00:03:00.000Z",
    };
    const initial = { ...createEmptyReadModel(baseTime), threads: [thread] };
    const withCurrent = yield* projectEvent(initial, goalEvent(1, currentGoal));
    const cleared = yield* projectEvent(withCurrent, clearEvent(2, "2026-08-17T00:03:00.500Z"));
    const replaced = yield* projectEvent(cleared, goalEvent(3, replacementGoal));

    expect(cleared.threads[0]?.goalRevisionAt).toBe("2026-08-17T00:03:00.000Z");
    expect(cleared.threads[0]?.goalRevisionSequence).toBe(2);
    expect(replaced.threads[0]?.goal).toEqual(replacementGoal);
    expect(replaced.threads[0]?.goalRevisionSequence).toBe(3);
  }),
);
