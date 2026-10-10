import type { OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { type HeldTask, normalizeBotApiUrl, START_GRACE_MS, taskProgress } from "./botTaskWork.ts";

const claimedAt = "2026-10-08T06:00:00.000Z";
const NOW = Date.parse(claimedAt) + 60_000;
const held: HeldTask = {
  taskId: "task-1",
  claimId: "claim-1",
  title: "Check releases",
  threadId: "thread-1",
  messageId: "message-1",
  claimedAt,
  started: true,
  outcome: null,
};

const message = (id: string, role: "user" | "assistant", text: string, streaming = false) => ({
  id,
  role,
  text,
  streaming,
});
const thread = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    title: "Check releases",
    deletedAt: null,
    latestTurn: { state: "completed" },
    session: { status: "ready", lastError: null },
    messages: [
      message("message-1", "user", "brief"),
      message("reply-1", "assistant", "Release 1.4 shipped."),
    ],
    ...overrides,
  }) as unknown as OrchestrationThread;

describe("taskProgress", () => {
  it("returns the task's reply with a pointer to its thread", () => {
    const progress = taskProgress(thread(), held, NOW);
    expect(progress).toEqual({
      kind: "done",
      status: "completed",
      result: "Release 1.4 shipped.\n\nHarness thread: Check releases",
    });
  });

  it("waits while the turn runs or its reply is still streaming", () => {
    expect(
      taskProgress(
        thread({ latestTurn: { state: "running" }, session: { status: "running" } }),
        held,
        NOW,
      ).kind,
    ).toBe("pending");
    expect(
      taskProgress(
        thread({
          messages: [
            message("message-1", "user", "brief"),
            message("reply-1", "assistant", "Rel", true),
          ],
        }),
        held,
        NOW,
      ).kind,
    ).toBe("pending");
    expect(taskProgress(thread({ messages: [], latestTurn: null }), held, NOW).kind).toBe(
      "pending",
    );
  });

  it("uses only the replies before the owner's next message in the same thread", () => {
    const later = thread({
      latestTurn: { state: "running" },
      session: { status: "running" },
      messages: [
        message("message-1", "user", "brief"),
        message("reply-1", "assistant", "First answer."),
        message("follow-up", "user", "Now something else"),
        message("reply-2", "assistant", "Other work", true),
      ],
    });
    const progress = taskProgress(later, held, NOW);
    expect(progress).toMatchObject({ kind: "done", status: "failed" });
    expect(progress.kind === "done" && progress.result).toContain("could not be confirmed");
    expect(progress.kind === "done" && progress.result).toContain(
      "Earlier reply (unconfirmed):\nFirst answer.",
    );
    expect(progress.kind === "done" && progress.result).not.toContain("Other work");
  });

  it.each(["running", "error", "interrupted", "completed"] as const)(
    "never turns an original %s assignment into success merely because its owner follows up",
    (state) => {
      const later = thread({
        latestTurn: { state },
        session: { status: state === "running" ? "running" : "ready" },
        messages: [
          message("message-1", "user", "brief"),
          message("follow-up", "user", "Now something else"),
        ],
      });
      expect(taskProgress(later, held, NOW)).toMatchObject({
        kind: "done",
        status: "failed",
        result: expect.stringContaining("could not be confirmed"),
      });
      expect(taskProgress(later, held, NOW)).not.toMatchObject({
        result: expect.stringContaining("Finished without a written reply"),
      });
    },
  );

  it("reports a failed turn with its reason and any partial reply", () => {
    const progress = taskProgress(
      thread({
        latestTurn: { state: "error" },
        session: { status: "error", lastError: "Provider failed" },
      }),
      held,
      NOW,
    );
    expect(progress).toMatchObject({ kind: "done", status: "failed" });
    expect(progress.kind === "done" && progress.result).toContain(
      "Provider failed\n\nPartial reply:\nRelease 1.4 shipped.",
    );
  });

  it("never treats an unstarted or vanished task as run", () => {
    expect(taskProgress(null, { ...held, started: false }, NOW)).toMatchObject({
      status: "failed",
      result: expect.stringContaining("nothing ran"),
    });
    expect(taskProgress(null, held, NOW)).toMatchObject({
      status: "failed",
      result: expect.stringContaining("result is unknown"),
    });
    const empty = thread({ messages: [], latestTurn: null, session: null });
    expect(taskProgress(empty, held, Date.parse(claimedAt) + START_GRACE_MS + 1)).toMatchObject({
      status: "failed",
      result: expect.stringContaining("nothing ran"),
    });
  });

  it("gives up waiting after a day and truncates long replies", () => {
    const stuck = thread({ latestTurn: { state: "running" }, session: { status: "running" } });
    expect(taskProgress(stuck, held, Date.parse(claimedAt) + 25 * 3_600_000)).toMatchObject({
      status: "failed",
      result: expect.stringContaining("after 24 hours"),
    });
    const long = thread({
      messages: [
        message("message-1", "user", "brief"),
        message("reply-1", "assistant", "é".repeat(60_000)),
      ],
    });
    const progress = taskProgress(long, held, NOW);
    expect(
      progress.kind === "done" && new TextEncoder().encode(progress.result).length,
    ).toBeLessThan(91_000);
    expect(progress.kind === "done" && progress.result).toContain("[Truncated.");
  });
});

describe("normalizeBotApiUrl", () => {
  it("accepts HTTPS and loopback HTTP only", () => {
    expect(normalizeBotApiUrl("https://bot.example.test/")).toBe("https://bot.example.test");
    expect(normalizeBotApiUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeBotApiUrl("http://bot.example.com")).toBeNull();
    expect(normalizeBotApiUrl("https://user:pass@bot.example.com")).toBeNull();
    expect(normalizeBotApiUrl("https://bot.example.com/?next=x")).toBeNull();
    expect(normalizeBotApiUrl("not a url")).toBeNull();
  });
});
