import { describe, expect, it } from "vite-plus/test";

import {
  appendProjectRecentLine,
  dailyNoteName,
  deviceFileLabel,
  projectNoteName,
  renderProjectNote,
  selectMemoryMessages,
} from "./memoryNotes.ts";

const DEVICE = deviceFileLabel({ name: "MacBook Pro", shortId: "3f2a" });

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
});

describe("projectNoteName", () => {
  it("removes characters that break links or Windows file names", () => {
    expect(projectNoteName('Acme: "App" [v2] / web.')).toBe("Acme App v2 web");
    expect(projectNoteName("CON")).toBe("CON project");
    expect(projectNoteName("  ")).toBe("Untitled project");
  });
});

describe("project notes", () => {
  const day27 = dailyNoteName("2026-09-27", DEVICE);
  const day28 = dailyNoteName("2026-09-28", DEVICE);
  const stub = () =>
    renderProjectNote({ title: "Acme App", workspaceRoot: "/code/acme", deviceLabel: DEVICE });

  it("replaces the day's line when that day is summarized again", () => {
    const first = appendProjectRecentLine(stub(), day27, "Found the bug");
    const withNext = appendProjectRecentLine(first, day28, "Login fix");
    const redone = appendProjectRecentLine(withNext, day27, "Found the cookie bug");
    expect(redone.split(`[[${day27}]]`)).toHaveLength(2);
    expect(redone).toContain(`- [[${day27}]]: Found the cookie bug\n- [[${day28}]]: Login fix\n`);
  });

  // regression: 76be8d04db name each thread's project note in the memory prompt and add a missing Recent section
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
