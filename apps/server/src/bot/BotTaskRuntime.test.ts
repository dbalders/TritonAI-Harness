import { describe, expect, it } from "@effect/vitest";
import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { botThreadState } from "./BotTaskRuntime.ts";
import { taskProgress } from "./botTaskWork.ts";

const at = DateTime.makeUnsafe("2026-10-20T12:00:00.000Z");
const shell = {
  id: "thread",
  projectId: "project",
  title: "Assignment",
  worktreePath: null,
  modelSelection: { instanceId: "codex", model: "test" },
  runtimeMode: "auto",
  interactionMode: "default",
  deletedAt: null,
  status: "running",
  latestRunId: "later",
  latestRunCompletedAt: null,
  pendingRuntimeRequest: null,
} as unknown as OrchestrationV2ThreadShell;
const message = (id: string, role: string, runId: string, text: string) => ({
  id,
  role,
  runId,
  text,
  streaming: false,
  createdAt: at,
  updatedAt: at,
});
const projection = () =>
  ({
    runs: [
      { id: "own", status: "completed", completedAt: at },
      { id: "later", status: "running", completedAt: null },
    ],
    messages: [
      message("assignment", "user", "own", "Inspect"),
      message("answer", "assistant", "own", "Own result"),
      message("followup", "user", "later", "Continue"),
      message("later-answer", "assistant", "later", "Later result"),
    ],
    nodes: [
      { id: "own-node", runId: "own" },
      { id: "later-node", runId: "later" },
    ],
    runtimeRequests: [
      {
        id: "later-request",
        nodeId: "later-node",
        kind: "command",
        status: "pending",
        createdAt: at,
        payload: { secret: "PRIVATE" },
      },
    ],
    turnItems: [{ type: "reasoning", text: "PRIVATE" }],
  }) as unknown as OrchestrationV2ThreadProjection;

describe("Bot V2 runtime boundary", () => {
  it("exports no other turn when the assignment message or run is missing", () => {
    const data = projection();
    expect(botThreadState(shell, data, "not-persisted").messages).toEqual([]);
    expect(
      botThreadState(shell, { ...data, runs: [] }, "assignment").messages.map((item) => item.id),
    ).toEqual(["assignment"]);
    for (const missing of [
      botThreadState(shell, data, "not-persisted"),
      botThreadState(shell, { ...data, runs: [] }, "assignment"),
    ]) {
      expect(missing.assignmentRunConfirmed).toBe(false);
      expect(missing.hasPendingApprovals).toBe(false);
      expect(missing.hasPendingUserInput).toBe(false);
      expect(missing.activities).toEqual([]);
      expect(JSON.stringify(missing)).not.toContain("Later result");
    }
  });

  it("reports and settles the assignment's own run even after a later run starts", () => {
    const state = botThreadState(shell, projection(), "assignment");
    expect(state.latestTurn).toMatchObject({ turnId: "own", state: "completed" });
    expect(state.hasPendingApprovals).toBe(false);
    expect(state.messages.map((message) => message.id)).toEqual(["assignment", "answer"]);
    const result = taskProgress(
      state,
      {
        taskId: "task",
        claimId: "claim",
        title: "Assignment",
        threadId: "thread",
        messageId: "assignment",
        started: true,
        claimedAt: DateTime.formatIso(at),
        outcome: null,
      },
      DateTime.toEpochMillis(at),
    );
    expect(result).toMatchObject({
      kind: "done",
      status: "completed",
      result: expect.stringContaining("Own result"),
    });
    expect(JSON.stringify(result)).not.toContain("Later result");
  });

  it("reports approval and input waits only for the assignment and never exports request bodies", () => {
    const data = projection();
    const state = botThreadState(
      shell,
      {
        ...data,
        runs: data.runs.map((run) => ({ ...run, status: "waiting" })),
        runtimeRequests: [
          ...data.runtimeRequests,
          {
            id: "own-request",
            nodeId: "own-node",
            kind: "user_input",
            status: "pending",
            createdAt: at,
            payload: { secret: "PRIVATE" },
          } as unknown as (typeof data.runtimeRequests)[number],
        ],
      },
      "assignment",
    );
    expect(state.hasPendingUserInput).toBe(true);
    expect(state.hasPendingApprovals).toBe(false);
    expect(state.latestTurn?.state).toBe("running");
    expect(JSON.stringify(state)).not.toContain("PRIVATE");
  });
});
