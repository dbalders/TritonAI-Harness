import type { TeamProjectSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { teamProjectSkillRows, teamProjectSkillsNotice } from "./teamProjectSkills";

const author = "a".repeat(43);
const path = (id: string) => `Skills/${author}/device/${id}.md`;
const version = (digit: string) => digit.repeat(64);
const skill = (overrides: Partial<TeamProjectSkill> & { path: string }): TeamProjectSkill => ({
  title: "Grant summary",
  version: version("1"),
  state: "active",
  ...overrides,
});

describe("teamProjectSkillRows", () => {
  it("lists skills that are on first, in the order they're added, then the rest", () => {
    const files = [
      {
        path: path("a"),
        summary: { title: "Agenda", description: "Plan a meeting", hidden: false },
      },
      { path: path("b"), summary: { title: "Budget", description: "Check costs", hidden: false } },
      { path: path("c"), summary: { title: "Hidden", description: "", hidden: true } },
      { path: path("d") },
    ];
    const rows = teamProjectSkillRows(files, { [author]: "Alice" }, [
      skill({ path: path("b"), title: "Budget" }),
      skill({ path: path("d"), title: "Draft letters", state: "needs-review", reason: "Changed." }),
      skill({ path: path("gone"), title: "Old", state: "unavailable", reason: "Removed." }),
    ]);
    expect(rows.map((row) => [row.label, row.state, row.reason])).toEqual([
      ["Budget", "on", null],
      // An unsummarized listing keeps the title the skill was approved under.
      ["Draft letters", "needs-review", "Changed."],
      ["Old", "not-applied", "Removed."],
      ["Agenda", "off", null],
      ["Hidden", "off", null],
    ]);
    expect(rows[0]).toMatchObject({ source: "From Alice", version: "111111111111" });
    expect(rows[2]!.source).toBe("No longer in the team’s Skills folder");
    // A hidden-text skill can't be turned on, and says so.
    expect(rows.find((row) => row.label === "Hidden")!.warning).toContain("hidden or control");
  });

  it("doesn't say a skill left the folder when the folder couldn't be listed", () => {
    const rows = teamProjectSkillRows(null, undefined, [
      skill({ path: path("a"), title: "Agenda", state: "unavailable" }),
    ]);
    expect(rows.map((row) => [row.label, row.source, row.state])).toEqual([
      ["Agenda", "Previously reviewed skill", "not-applied"],
    ]);
  });
});

describe("teamProjectSkillsNotice", () => {
  it("names what is added to each message, and what is held back and why", () => {
    expect(teamProjectSkillsNotice("Team A", [])).toBeNull();
    expect(
      teamProjectSkillsNotice("Team A", [
        skill({ path: path("a"), title: "Agenda" }),
        skill({ path: path("b"), title: "Budget" }),
      ]),
    ).toMatchObject({ variant: "info", title: "Team skills on: “Agenda”, “Budget”" });
    const withheld = teamProjectSkillsNotice("Team A", [
      skill({ path: path("a"), title: "Agenda" }),
      skill({
        path: path("b"),
        title: "Budget",
        state: "needs-review",
        reason: "This skill changed since you turned it on.",
      }),
    ]);
    expect(withheld).toEqual({
      variant: "warning",
      title: "“Budget” isn’t being added to your messages",
      description:
        "This skill changed since you turned it on. Review it or turn it off in Settings → Skills. Still added: “Agenda”.",
    });
  });
});
