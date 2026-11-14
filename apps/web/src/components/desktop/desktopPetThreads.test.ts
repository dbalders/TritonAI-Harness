import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { computePetSummaries, isPetThreadActive } from "./desktopPetThreads";

type Overrides = Omit<Partial<EnvironmentThreadShell>, "id" | "runtime"> & {
  id?: string;
  runtime?: Pick<NonNullable<EnvironmentThreadShell["runtime"]>, "status">;
};
function thread(overrides: Overrides): EnvironmentThreadShell {
  return {
    environmentId: "environment",
    id: "thread",
    title: "Thread",
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    updatedAt: "2026-10-23T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  } as EnvironmentThreadShell;
}

describe("desktop pet threads", () => {
  it("retains threads that finish in this pet session but excludes old idle threads", () => {
    const seen: Set<string> = new Set();
    computePetSummaries([thread({ id: "recent", runtime: { status: "running" } })], seen);
    const result = computePetSummaries(
      [
        thread({ id: "recent", runtime: { status: "completed" } }),
        thread({ id: "old", runtime: { status: "idle" } }),
      ],
      seen,
    );
    expect(result.map((item) => item.threadId)).toEqual(["recent"]);
    expect(result[0]?.statusLabel).toBe("Done");
    seen.clear();
    expect(
      computePetSummaries([thread({ id: "recent", runtime: { status: "completed" } })], seen),
    ).toEqual([]);
  });
  it("includes active and actionable threads", () => {
    expect(isPetThreadActive(thread({ runtime: { status: "running" } }))).toBe(true);
    expect(isPetThreadActive(thread({ hasPendingApprovals: true }))).toBe(true);
    expect(isPetThreadActive(thread({ hasActionableProposedPlan: true }))).toBe(true);
    expect(
      isPetThreadActive(thread({ pendingBackgroundTasks: [{ taskId: "task", kind: "subagent" }] })),
    ).toBe(true);
  });

  it("excludes archived, deleted, and idle threads", () => {
    expect(isPetThreadActive(thread({ archivedAt: "2026-10-23T00:00:00.000Z" }))).toBe(false);
    expect(isPetThreadActive(thread({ deletedAt: "2026-10-23T00:00:00.000Z" }))).toBe(false);
    expect(isPetThreadActive(thread({ runtime: { status: "idle" } }))).toBe(false);
    expect(isPetThreadActive(thread({ runtime: { status: "failed" } }))).toBe(false);
  });

  it("keeps a bounded active-thread payload", () => {
    const threads = Array.from({ length: 20 }, (_, index) =>
      thread({ id: "thread-" + index, runtime: { status: "running" } }),
    );
    expect(computePetSummaries(threads)).toHaveLength(12);
  });

  it("labels the reason a thread is active", () => {
    const summaries = computePetSummaries([
      thread({ id: "approval", hasPendingApprovals: true }),
      thread({ id: "running", runtime: { status: "running" } }),
    ]);
    expect(summaries.map((item) => item.statusLabel)).toEqual(["Approval", "Running"]);
  });
});
