import { describe, expect, it } from "vite-plus/test";
import { RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import { projectHomeThreads, projectMemorySections, projectThreadExcerpt } from "./projectHomeView";

describe("project home", () => {
  it("keeps an unanswered request out of finished work even after a previous completed run", () => {
    const completed = {
      runId: RunId.make("run"),
      status: "completed" as const,
      requestedAt: null,
      startedAt: null,
      completedAt: "2026-10-17T12:00:00Z",
      assistantMessageId: null,
    };
    const waiting = makeThreadFixture({
      id: ThreadId.make("waiting"),
      hasPendingApprovals: true,
      latestRun: completed,
    });
    const finished = makeThreadFixture({ id: ThreadId.make("finished"), latestRun: completed });
    const failed = makeThreadFixture({
      id: ThreadId.make("failed"),
      latestRun: { ...completed, status: "failed" },
    });
    const archived = makeThreadFixture({
      id: ThreadId.make("archived"),
      archivedAt: "2026-10-17T12:00:00Z",
    });
    const view = projectHomeThreads([finished, archived, waiting, failed]);
    expect(view.needsYou).toEqual([waiting, failed]);
    expect(view.finished).toEqual([finished]);
    expect(view.recent).not.toContain(archived);
  });

  it("uses the recent end of the running memory history and hides metadata", () => {
    const sections = projectMemorySections(
      '---\nworkspace: "/private/work"\n---\n# Project\n\n## Recent\n' +
        Array.from({ length: 8 }, (_, i) => `- [[2026-10-${10 + i} Computer]]: Result ${i}`).join(
          "\n",
        ),
    );
    expect(sections[0]?.lines).toHaveLength(5);
    expect(sections[0]?.lines[0]).toBe("2026-10-17 Computer: Result 7");
    expect(JSON.stringify(sections)).not.toContain("/private/work");
  });

  it("makes agent updates readable without losing the report's wording", () => {
    const thread = makeThreadFixture();
    expect(
      projectThreadExcerpt(
        thread,
        "Created [checklist.md](/local/checklist.md) for review.\nNot deployed.",
      ),
    ).toBe("Created checklist.md for review. Not deployed.");
    expect(projectThreadExcerpt(thread, " ")).toBeNull();
  });
});
