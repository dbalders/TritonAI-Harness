import { describe, expect, it } from "vite-plus/test";

import {
  appendProjectRecentLine,
  isHarnessNote,
  mergeDailyNote,
  type MemoryThreadActivity,
  projectNoteName,
  renderDailyNote,
  renderProjectNote,
  selectMemoryMessages,
} from "./memoryNotes.ts";

const thread = (overrides: Partial<MemoryThreadActivity> = {}): MemoryThreadActivity => ({
  threadId: "thread-1",
  title: "Fix the login redirect",
  branch: "fix/login",
  pullRequestUrl: "https://github.com/acme/app/pull/12",
  projectId: "project-1",
  projectTitle: "Acme App",
  workspaceRoot: "/code/acme",
  codexThreadId: "01a0-codex",
  messages: [],
  ...overrides,
});

describe("selectMemoryMessages", () => {
  it("keeps user messages and only the final agent message of each turn", () => {
    const selected = selectMemoryMessages([
      { turnId: "t1", role: "user", text: "fix it", createdAt: "2026-09-28T10:00:00.000Z" },
      { turnId: "t1", role: "assistant", text: "looking", createdAt: "2026-09-28T10:01:00.000Z" },
      { turnId: "t1", role: "assistant", text: "fixed", createdAt: "2026-09-28T10:02:00.000Z" },
      { turnId: "t2", role: "user", text: "ship it", createdAt: "2026-09-28T11:00:00.000Z" },
      { turnId: "t2", role: "assistant", text: "shipped", createdAt: "2026-09-28T11:05:00.000Z" },
    ]);
    expect(selected.map((message) => message.text)).toEqual([
      "fix it",
      "fixed",
      "ship it",
      "shipped",
    ]);
  });

  it("keeps every agent message that has no turn id", () => {
    const selected = selectMemoryMessages([
      { turnId: null, role: "assistant", text: "first", createdAt: "2026-09-28T10:00:00.000Z" },
      { turnId: null, role: "assistant", text: "second", createdAt: "2026-09-28T11:00:00.000Z" },
    ]);
    expect(selected.map((message) => message.text)).toEqual(["first", "second"]);
  });
});

describe("projectNoteName", () => {
  it("removes characters that break links or Windows file names", () => {
    expect(projectNoteName('Acme: "App" [v2] / web.')).toBe("Acme App v2 web");
    expect(projectNoteName("CON")).toBe("CON project");
    expect(projectNoteName("  ")).toBe("Untitled project");
  });
});

describe("renderDailyNote", () => {
  it("links projects, the previous day, inbox notes, and each thread's session", () => {
    const note = renderDailyNote({
      day: "2026-09-28",
      summary: {
        overview: "Fixed login.",
        projects: [
          { project: "acme app", workedOn: ["Fixed the redirect loop."], recent: "Login fix" },
        ],
        decisions: ["Keep the old cookie name."],
        openLoops: [],
      },
      threads: [thread()],
      projectNoteNames: new Map([["project-1", "Acme App"]]),
      sessionPaths: new Map([["01a0-codex", "/codex/sessions/rollout-x-01a0-codex.jsonl"]]),
      previousDay: "2026-09-26",
      inboxLinks: ["Inbox/processed/2026-09-28/2026-09-28-1030-login"],
    });

    expect(isHarnessNote(note)).toBe(true);
    expect(note).toContain('projects:\n  - "Acme App"');
    expect(note).toContain("### [[Acme App]]\n\n- Fixed the redirect loop.");
    expect(note).toContain("- Keep the old cookie name.");
    expect(note).toContain("## Open Loops\n\n- None recorded.");
    expect(note).toContain(
      "- **Fix the login redirect** in [[Acme App]] on `fix/login`. Pull request: https://github.com/acme/app/pull/12. Session: `/codex/sessions/rollout-x-01a0-codex.jsonl`",
    );
    expect(note).toContain("- Previous day: [[Daily/2026-09-26]]");
    expect(note).toContain("- Inbox: [[Inbox/processed/2026-09-28/2026-09-28-1030-login]]");
  });

  it("falls back to the Codex thread id when the session file is missing", () => {
    const note = renderDailyNote({
      day: "2026-09-28",
      summary: { overview: "", projects: [], decisions: [], openLoops: [] },
      threads: [thread({ branch: null, pullRequestUrl: null })],
      projectNoteNames: new Map([["project-1", "Acme App"]]),
      sessionPaths: new Map(),
      previousDay: null,
      inboxLinks: [],
    });
    expect(note).toContain(
      "- **Fix the login redirect** in [[Acme App]]. Codex thread: `01a0-codex`",
    );
    expect(note).not.toContain("## Links");
  });
});

describe("project notes", () => {
  it("adds one dated line and leaves the rest of the note alone", () => {
    const stub = renderProjectNote({ title: "Acme App", workspaceRoot: "/code/acme" });
    const edited = stub.replace("Your notes go here.", "Deploys go through staging first.");
    const once = appendProjectRecentLine(edited, "2026-09-28", "Login fix");
    expect(once).toContain("Deploys go through staging first.");
    expect(once.endsWith("- [[Daily/2026-09-28]]: Login fix\n")).toBe(true);
    expect(appendProjectRecentLine(once, "2026-09-28", "Login fix")).toBe(once);
  });

  it("replaces the day's line when that day is summarized again", () => {
    const stub = renderProjectNote({ title: "Acme App", workspaceRoot: "/code/acme" });
    const first = appendProjectRecentLine(stub, "2026-09-27", "Found the bug");
    const withNext = appendProjectRecentLine(first, "2026-09-28", "Login fix");
    const redone = appendProjectRecentLine(withNext, "2026-09-27", "Found the cookie bug");
    expect(redone.match(/\[\[Daily\/2026-09-27\]\]/gu)).toHaveLength(1);
    expect(redone).toContain(
      "- [[Daily/2026-09-27]]: Found the cookie bug\n- [[Daily/2026-09-28]]: Login fix\n",
    );
  });

  it("never rewrites a same-day line the user pinned", () => {
    const stub = renderProjectNote({ title: "Acme App", workspaceRoot: "/code/acme" });
    const pinned = stub.replace(
      "Your notes go here.",
      "- [[Daily/2026-09-28]]: The day we chose cookie sessions.",
    );
    const updated = appendProjectRecentLine(pinned, "2026-09-28", "Login fix");
    expect(updated).toContain("- [[Daily/2026-09-28]]: The day we chose cookie sessions.");
    expect(updated.endsWith("## Recent\n- [[Daily/2026-09-28]]: Login fix\n")).toBe(true);
  });

  it("adds a Recent section to a note without one instead of touching the user's lines", () => {
    const userNote = "# Acme\n\n- [[Daily/2026-09-28]]: The day we chose cookie sessions.\n";
    const updated = appendProjectRecentLine(userNote, "2026-09-28", "Login fix");
    expect(updated).toBe(
      "# Acme\n\n- [[Daily/2026-09-28]]: The day we chose cookie sessions.\n\n## Recent\n\n- [[Daily/2026-09-28]]: Login fix\n",
    );
    expect(appendProjectRecentLine(updated, "2026-09-28", "Login fix")).toBe(updated);
  });

  it("keeps a user's daily note above one summary, even when the day is redone", () => {
    const render = (overview: string) =>
      renderDailyNote({
        day: "2026-09-28",
        summary: { overview, projects: [], decisions: [], openLoops: [] },
        threads: [],
        projectNoteNames: new Map(),
        sessionPaths: new Map(),
        previousDay: null,
        inboxLinks: [],
      });
    expect(mergeDailyNote(null, render("First."))).toBe(render("First."));
    expect(mergeDailyNote(render("First."), render("Second."))).toBe(render("Second."));

    const first = mergeDailyNote("# My own notes\n", render("First."));
    expect(first).toBe(`# My own notes\n\n---\n\n${render("First.")}`);
    const redone = mergeDailyNote(first, render("Second."));
    expect(redone).toBe(`# My own notes\n\n---\n\n${render("Second.")}`);
  });

  it("only treats notes Harness wrote as its own", () => {
    expect(isHarnessNote("# My notes\n")).toBe(false);
    expect(isHarnessNote("---\ntype: daily\n---\n")).toBe(false);
  });
});
