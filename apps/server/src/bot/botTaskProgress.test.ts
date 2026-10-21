import type { BotTaskThread } from "./BotTaskRuntime.ts";
import { describe, expect, it } from "@effect/vitest";
import { botTaskSnapshot } from "./botTaskProgress.ts";

describe("Bot task progress", () => {
  it("bounds public snapshots and omits reasoning, tool payloads, and attachments", () => {
    const task = {
      taskId: "task",
      claimId: "claim",
      title: "Test",
      threadId: "thread",
      messageId: "user",
      claimedAt: "2026-10-14T00:00:00.000Z",
      started: true,
      outcome: null,
    };
    const shell = {
      title: "Test",
      latestTurn: { state: "running" },
      session: { status: "running" },
      hasPendingApprovals: true,
      hasPendingUserInput: false,
    } as BotTaskThread;
    const thread = {
      messages: [
        { id: "user", role: "user", text: "Prompt", createdAt: "2026-10-14T00:00:00.000Z" },
        ...Array.from({ length: 10 }, () => ({
          role: "assistant",
          text: "a🦭".repeat(1000),
          createdAt: "2026-10-14T00:00:00.000Z",
          attachments: [{ data: "PRIVATE-ATTACHMENT" }],
        })),
      ],
      activities: [
        { kind: "reasoning.delta", summary: "PRIVATE-REASONING", payload: {} },
        { kind: "approval.requested", summary: "Approve command", payload: { requestId: "one" } },
        { kind: "approval.requested", summary: "Approve command", payload: { requestId: "two" } },
        { kind: "x".repeat(81), summary: "Long kind", payload: {} },
        { kind: "tool.completed", summary: "Read file", payload: { raw: "PRIVATE-PAYLOAD" } },
      ],
    } as unknown as BotTaskThread;
    const progress = botTaskSnapshot(
      task,
      { deviceId: "device", projectId: "project", observedAt: "2026-10-14T00:00:00.000Z" },
      shell,
      thread,
    );
    expect(progress.phase).toBe("waiting-approval");
    expect(progress.pendingApprovals).toBe(2);
    expect(progress.messages).toHaveLength(6);
    expect(progress.messages.every((message) => message.text.length <= 1000)).toBe(true);
    expect(progress.activity.every((activity) => activity.kind.length <= 80)).toBe(true);
    const encoded = JSON.stringify(progress);
    expect(Buffer.byteLength(encoded)).toBeLessThan(24 * 1024);
    expect(encoded).not.toContain("PRIVATE-");
    expect(progress.activity.some((activity) => activity.kind.includes("reasoning"))).toBe(false);
  });
});
