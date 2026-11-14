import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import {
  projectHomeHeadline,
  projectHomeThreads,
  projectMemoryNote,
  projectThreadExcerpt,
  projectThreadStatus,
} from "./projectHomeView";

const completed = {
  runId: RunId.make("run"),
  status: "completed" as const,
  requestedAt: null,
  startedAt: null,
  completedAt: "2026-10-17T12:00:00Z",
  assistantMessageId: null,
};

const workingRuntime = {
  status: "running" as const,
  activeRunId: RunId.make("current-run"),
  providerInstanceId: makeThreadFixture().providerInstanceId,
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-10-17T12:05:00Z",
};

describe("project home", () => {
  it("keeps an unanswered request out of the finished updates even after a completed run", () => {
    const waiting = makeThreadFixture({
      id: ThreadId.make("waiting"),
      hasPendingApprovals: true,
      latestRun: completed,
      updatedAt: "2026-10-17T12:03:00Z",
    });
    const finished = makeThreadFixture({
      id: ThreadId.make("finished"),
      latestRun: completed,
      updatedAt: "2026-10-17T12:04:00Z",
    });
    const failed = makeThreadFixture({
      id: ThreadId.make("failed"),
      latestRun: { ...completed, status: "failed" },
      updatedAt: "2026-10-17T12:02:00Z",
    });
    const archived = makeThreadFixture({
      id: ThreadId.make("archived"),
      archivedAt: "2026-10-17T12:00:00Z",
    });
    const view = projectHomeThreads([finished, archived, waiting, failed]);
    expect(view.needsYou).toEqual([waiting, failed]);
    expect(view.updates).toEqual([finished]);
    expect(view.recent).not.toContain(archived);
    expect(projectThreadStatus(finished)?.label).toBe("Agent finished");
    expect(projectHomeHeadline(view, true)).toBe("2 threads need you");
  });

  // regression: #412 fix(web): keep project overview working rows stable
  it("keeps working rows in a fixed order as progress updates arrive", () => {
    const running = (id: string, createdAt: string, updatedAt: string) =>
      makeThreadFixture({
        id: ThreadId.make(id),
        createdAt,
        updatedAt,
        runtime: workingRuntime,
        latestRun: { ...completed, status: "running", completedAt: null },
      });
    const older = running("older", "2026-10-17T09:00:00Z", "2026-10-17T12:05:00Z");
    const newer = running("newer", "2026-10-17T10:00:00Z", "2026-10-17T12:04:00Z");
    expect(projectHomeThreads([older, newer]).working).toEqual([newer, older]);

    const progressed = {
      ...older,
      updatedAt: "2026-10-17T12:06:00Z",
      source: {
        ...older.source,
        latestVisibleMessage: {
          id: MessageId.make("progress"),
          role: "assistant" as const,
          text: "Tests passed. Checking the next tool result.",
          updatedAt: older.source.updatedAt,
        },
      },
    };
    const view = projectHomeThreads([newer, progressed]);
    expect(view.working).toEqual([newer, progressed]);
    expect(projectThreadExcerpt(view.working[1]!)).toBe(
      "Tests passed. Checking the next tool result.",
    );
    expect(view.recent[0]).toBe(progressed);
  });

  it("reads the running memory history newest first without metadata or device names", () => {
    const note = projectMemoryNote(
      '---\nworkspace: "/private/work"\n---\n# Project on Laptop\n\nHarness keeps this note.\n\n## Recent\n' +
        Array.from({ length: 3 }, (_, i) => `- [[2026-10-1${i} Laptop (e9cd)]]: Result ${i}`).join(
          "\n",
        ) +
        "\n\n## Notes\n- Use the [[staging|staging stack]]\n",
    );
    expect(note.history).toEqual([
      { day: "2026-10-12", text: "Result 2" },
      { day: "2026-10-11", text: "Result 1" },
      { day: "2026-10-10", text: "Result 0" },
    ]);
    expect(note.sections).toEqual([{ heading: "Notes", lines: ["Use the staging stack"] }]);
    expect(JSON.stringify(note)).not.toContain("/private/work");
    expect(JSON.stringify(note)).not.toContain("Laptop");
  });
});
