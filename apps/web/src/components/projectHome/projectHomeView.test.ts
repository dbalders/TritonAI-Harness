import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadFixture } from "../../test-fixtures";
import {
  projectHomeDays,
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

  it("limits the quiet headline to agent requests, including disconnected state", () => {
    const view = projectHomeThreads([makeThreadFixture({ latestRun: completed })]);
    expect(projectHomeHeadline(view, true)).toBe("No pending agent requests");
    expect(projectHomeHeadline(view, false)).toBe("No saved agent requests pending");
    expect(projectHomeHeadline(projectHomeThreads([]), true)).toBe("No threads yet");
  });

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

  it("breaks working-row ties consistently and moves completed work into latest updates", () => {
    const first = makeThreadFixture({
      id: ThreadId.make("a"),
      runtime: workingRuntime,
      latestRun: { ...completed, status: "running", completedAt: null },
      updatedAt: "2026-10-17T12:05:00Z",
    });
    const second = { ...first, id: ThreadId.make("b") };
    expect(projectHomeThreads([second, first]).working).toEqual([first, second]);
    expect(projectHomeThreads([first, second]).working).toEqual([first, second]);

    const finished = {
      ...first,
      runtime: null,
      latestRun: completed,
      updatedAt: "2026-10-17T12:06:00Z",
    };
    const previous = makeThreadFixture({
      id: ThreadId.make("previous"),
      latestRun: completed,
      updatedAt: "2026-10-17T12:04:00Z",
    });
    const view = projectHomeThreads([previous, second, finished]);
    expect(view.working).toEqual([second]);
    expect(view.updates).toEqual([finished, previous]);
  });

  it("shows current work ahead of a previous failed run, while requests still take priority", () => {
    const base = makeThreadFixture();
    const running = makeThreadFixture({
      latestRun: { ...completed, status: "failed" },
      runtime: {
        status: "running",
        activeRunId: RunId.make("current-run"),
        providerInstanceId: base.providerInstanceId,
        providerName: "Codex",
        lastError: null,
        updatedAt: "2026-10-17T12:05:00Z",
      },
    });
    expect(projectHomeThreads([running]).working).toEqual([running]);
    expect(projectThreadStatus(running)?.label).toBe("Working");
    expect(projectThreadStatus({ ...running, hasPendingUserInput: true })?.label).toBe(
      "Has a question for you",
    );
  });

  it("never presents the user's last message as an agent report", () => {
    const base = makeThreadFixture();
    const source = {
      ...base.source,
      latestVisibleMessage: {
        id: MessageId.make("last-message"),
        role: "user" as const,
        text: "Please deploy this",
        updatedAt: base.source.updatedAt,
      },
    };
    const thread = { ...base, source };
    expect(projectThreadExcerpt(thread)).toBeNull();
    expect(projectThreadExcerpt(thread, "Prepared for review.")).toBe("Prepared for review.");
    expect(
      projectThreadExcerpt({
        ...thread,
        source: {
          ...source,
          latestVisibleMessage: { ...source.latestVisibleMessage, role: "assistant" },
        },
      }),
    ).toBe("Please deploy this");
  });

  it("groups updates under the local day they last changed", () => {
    const at = (id: string, hour: number, day: number) =>
      makeThreadFixture({
        id: ThreadId.make(id),
        updatedAt: new Date(2026, 9, day, hour).toISOString(),
      });
    const days = projectHomeDays(
      [at("a", 15, 17), at("b", 9, 17), at("c", 20, 16)],
      new Date(2026, 9, 17, 18).getTime(),
    );
    expect(days.map((day) => [day.label, day.threads.map((thread) => thread.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
    ]);
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

  it("makes agent updates readable without losing the report's wording", () => {
    const thread = makeThreadFixture();
    expect(
      projectThreadExcerpt(
        thread,
        "## Done\nCreated [checklist.md](/local/checklist.md) for **review**.\nNot deployed.",
      ),
    ).toBe("Done Created checklist.md for review. Not deployed.");
    expect(projectThreadExcerpt(thread, " ")).toBeNull();
  });
});
