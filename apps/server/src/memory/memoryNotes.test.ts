import { describe, expect, it } from "vite-plus/test";

import {
  appendProjectRecentLine,
  type DailyNoteInput,
  dailyNoteName,
  deviceFileLabel,
  type MemoryThreadActivity,
  projectNoteFileName,
  projectNoteName,
  renderDailyNote,
  renderProjectNote,
  selectMemoryMessages,
} from "./memoryNotes.ts";

const DEVICE = deviceFileLabel({ name: "MacBook Pro", shortId: "3f2a" });
const note = (overrides: Partial<DailyNoteInput> = {}): DailyNoteInput => ({
  day: "2026-09-28",
  deviceLabel: DEVICE,
  status: "final",
  updatedThrough: "2026-09-29T07:00:00.000Z",
  timeZone: "America/Los_Angeles",
  summary: { overview: "", projects: [], decisions: [], openLoops: [] },
  threads: [],
  projectNoteNames: new Map(),
  sessionPaths: new Map(),
  previousDay: null,
  inboxLinks: [],
  ...overrides,
});

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

describe("file names", () => {
  it("names every generated note after the device that wrote it", () => {
    expect(DEVICE).toBe("MacBook Pro (3f2a)");
    expect(dailyNoteName("2026-09-28", DEVICE)).toBe("2026-09-28 MacBook Pro (3f2a)");
    expect(projectNoteFileName("Acme App", DEVICE)).toBe("Acme App - MacBook Pro (3f2a)");
  });
});

describe("renderDailyNote", () => {
  it("links this device's project notes, previous day, inbox notes, and each thread's session", () => {
    const rendered = renderDailyNote(
      note({
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
        inboxLinks: ["Inbox/3f2a/processed/2026-09-28/2026-09-28-1030-login"],
      }),
    );

    expect(rendered).toContain('device: "MacBook Pro (3f2a)"\nstatus: final\n');
    expect(rendered).toContain('timezone: "America/Los_Angeles"');
    expect(rendered).toContain('projects:\n  - "Acme App"');
    expect(rendered).toContain("# 2026-09-28 on MacBook Pro (3f2a)");
    expect(rendered).toContain(
      "### [[Acme App - MacBook Pro (3f2a)|Acme App]]\n\n- Fixed the redirect loop.",
    );
    expect(rendered).toContain("- Keep the old cookie name.");
    expect(rendered).toContain("## Open Loops\n\n- None recorded.");
    expect(rendered).toContain(
      "- **Fix the login redirect** in [[Acme App - MacBook Pro (3f2a)|Acme App]] on `fix/login`. Pull request: https://github.com/acme/app/pull/12. Session: `/codex/sessions/rollout-x-01a0-codex.jsonl`",
    );
    expect(rendered).toContain("- Previous day: [[2026-09-26 MacBook Pro (3f2a)]]");
    expect(rendered).toContain(
      "- Inbox: [[Inbox/3f2a/processed/2026-09-28/2026-09-28-1030-login]]",
    );
    expect(rendered).not.toContain("So far today");
  });

  it("marks today's note as partial until the day is done", () => {
    const rendered = renderDailyNote(
      note({ status: "partial", updatedThrough: "2026-09-28T20:00:00.000Z" }),
    );
    expect(rendered).toContain("status: partial\nupdatedThrough: 2026-09-28T20:00:00.000Z\n");
    expect(rendered).toContain("_So far today.");
  });

  it("says when a day only had inbox notes", () => {
    const rendered = renderDailyNote(
      note({ inboxLinks: ["Inbox/3f2a/processed/2026-09-28/2026-09-28-1030-login"] }),
    );
    expect(rendered).toContain("## Threads\n\n- None. This day only had inbox notes.");
  });

  it("falls back to the Codex thread id when the session file is missing", () => {
    const rendered = renderDailyNote(
      note({
        threads: [thread({ branch: null, pullRequestUrl: null })],
        projectNoteNames: new Map([["project-1", "Acme App"]]),
      }),
    );
    expect(rendered).toContain(
      "- **Fix the login redirect** in [[Acme App - MacBook Pro (3f2a)|Acme App]]. Codex thread: `01a0-codex`",
    );
    expect(rendered).not.toContain("## Links");
  });
});

describe("project notes", () => {
  const day27 = dailyNoteName("2026-09-27", DEVICE);
  const day28 = dailyNoteName("2026-09-28", DEVICE);
  const stub = () =>
    renderProjectNote({ title: "Acme App", workspaceRoot: "/code/acme", deviceLabel: DEVICE });

  it("starts with only a Recent section and points people to Notes", () => {
    const created = stub();
    expect(created).toContain('device: "MacBook Pro (3f2a)"');
    expect(created).toContain("# Acme App on MacBook Pro (3f2a)");
    expect(created).toContain("`Notes` folder");
    expect(created).not.toContain("## Pinned");
    expect(created.endsWith("## Recent\n")).toBe(true);
  });

  it("adds one dated line per day", () => {
    const once = appendProjectRecentLine(stub(), day28, "Login fix");
    expect(once.endsWith(`- [[${day28}]]: Login fix\n`)).toBe(true);
    expect(appendProjectRecentLine(once, day28, "Login fix")).toBe(once);
  });

  it("replaces the day's line when that day is summarized again", () => {
    const first = appendProjectRecentLine(stub(), day27, "Found the bug");
    const withNext = appendProjectRecentLine(first, day28, "Login fix");
    const redone = appendProjectRecentLine(withNext, day27, "Found the cookie bug");
    expect(redone.split(`[[${day27}]]`)).toHaveLength(2);
    expect(redone).toContain(`- [[${day27}]]: Found the cookie bug\n- [[${day28}]]: Login fix\n`);
  });

  it("adds a Recent section to a note without one instead of touching other lines", () => {
    const other = `# Acme\n\n- [[${day28}]]: The day we chose cookie sessions.\n`;
    const updated = appendProjectRecentLine(other, day28, "Login fix");
    expect(updated).toBe(
      `# Acme\n\n- [[${day28}]]: The day we chose cookie sessions.\n\n## Recent\n\n- [[${day28}]]: Login fix\n`,
    );
    expect(appendProjectRecentLine(updated, day28, "Login fix")).toBe(updated);
  });

  it("keeps history inside Recent when another section follows it", () => {
    const content = [
      "# Acme",
      "",
      "## Recent",
      "",
      `- [[${day27}]]: Found the bug`,
      "",
      "## Personal notes",
      "",
      `- [[${day28}]]: Keep the existing deployment policy.`,
      "",
    ].join("\n");
    const updated = appendProjectRecentLine(content, day28, "Login fix");
    expect(updated).toBe(
      [
        "# Acme",
        "",
        "## Recent",
        "",
        `- [[${day27}]]: Found the bug`,
        `- [[${day28}]]: Login fix`,
        "",
        "## Personal notes",
        "",
        `- [[${day28}]]: Keep the existing deployment policy.`,
        "",
      ].join("\n"),
    );
    expect(appendProjectRecentLine(updated, day28, "Login fix again")).toBe(
      updated.replace("Login fix", "Login fix again"),
    );
  });
});
