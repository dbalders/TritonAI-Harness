import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const now = "2026-07-22T00:00:00.000Z";
const threadId = ThreadId.make("thread-goal");
const thread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-goal"),
  title: "New thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
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

it.layer(NodeServices.layer)("goal decider", (it) => {
  it.effect("requests a goal with the selected provider without starting a normal turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.make("command-goal-start"),
          threadId,
          objective: "Ship goal support",
          status: "active",
          tokenBudget: 50_000,
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
          },
          createdAt: now,
        },
        readModel: { ...createEmptyReadModel(now), threads: [thread] },
      });

      expect("type" in result).toBe(true);
      if (!("type" in result) || result.type !== "thread.goal-set-requested") return;
      expect(result.payload).toMatchObject({
        threadId,
        objective: "Ship goal support",
        status: "active",
        tokenBudget: 50_000,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      });
    }),
  );

  it.effect("wakes settled and snoozed threads for goal requests and provider goal sync", () =>
    Effect.gen(function* () {
      const setResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.make("command-goal-settled-start"),
          threadId,
          objective: "Ship goal support",
          status: "active",
          createdAt: now,
        },
        readModel: {
          ...createEmptyReadModel(now),
          threads: [
            {
              ...thread,
              settledOverride: "settled",
              settledAt: now,
              snoozedUntil: "2026-07-23T00:00:00.000Z",
              snoozedAt: now,
            },
          ],
        },
      });
      const setEvents = Array.isArray(setResult) ? setResult : [setResult];
      expect(setEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.unsnoozed",
        "thread.goal-set-requested",
      ]);

      const syncResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.sync",
          commandId: CommandId.make("command-goal-active-sync"),
          threadId,
          goal: {
            objective: "Ship goal support",
            status: "active",
            tokenBudget: null,
            tokensUsed: 100,
            timeUsedSeconds: 10,
            createdAt: now,
            updatedAt: now,
          },
          createdAt: now,
        },
        readModel: {
          ...createEmptyReadModel(now),
          threads: [{ ...thread, settledOverride: "active" }],
        },
      });
      const syncEvents = Array.isArray(syncResult) ? syncResult : [syncResult];
      expect(syncEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.goal-updated",
      ]);
    }),
  );

  it.effect("requires an objective when no provider-confirmed goal exists", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.set",
          commandId: CommandId.make("command-goal-status-without-goal"),
          threadId,
          status: "paused",
          createdAt: now,
        },
        readModel: { ...createEmptyReadModel(now), threads: [thread] },
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("does not wake a settled thread for a stale reconnect goal sync", () =>
    Effect.gen(function* () {
      const currentGoalUpdatedAt = "2026-07-22T00:02:00.000Z";
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.sync",
          commandId: CommandId.make("command-goal-stale-reconnect-sync"),
          threadId,
          goal: {
            objective: "Delayed reconnect goal",
            status: "active",
            tokenBudget: null,
            tokensUsed: 50,
            timeUsedSeconds: 5,
            createdAt: now,
            updatedAt: "2026-07-22T00:01:00.000Z",
          },
          createdAt: "2026-07-22T00:03:00.000Z",
        },
        readModel: {
          ...createEmptyReadModel(now),
          threads: [
            {
              ...thread,
              settledOverride: "settled",
              settledAt: currentGoalUpdatedAt,
              goalRevisionAt: currentGoalUpdatedAt,
            },
          ],
        },
      });

      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.goal-updated"]);
    }),
  );
});
