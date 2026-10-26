import { describe, expect, it } from "vite-plus/test";
import type { Idea } from "@t3tools/contracts";
import { IDEA_GROUPS, ideaBasis, ideaHeadline, ideasInGroup, ideaSourceNames } from "./ideaDisplay";

describe("ideaHeadline", () => {
  it("turns an older offer into the task itself", () => {
    expect(ideaHeadline("I can compare the two course CSVs")).toBe("Compare the two course CSVs");
  });

  it("leaves a task title alone", () => {
    expect(ideaHeadline("Summarize your open Jira tickets")).toBe(
      "Summarize your open Jira tickets",
    );
  });

  it("keeps a title that is only the prefix", () => {
    expect(ideaHeadline("I can ")).toBe("I can ");
  });
});

describe("ideaBasis", () => {
  const sources = [
    { kind: "plugin", label: "Plugin · n8n" },
    { kind: "note", label: "Note · Oct 13" },
    { kind: "thread", label: "Thread · Check the export" },
  ] as const;

  it("names the first sources plainly and counts the rest", () => {
    expect(ideaBasis(sources)).toBe("Based on n8n, Oct 13 note +1");
  });

  it("quotes a thread title", () => {
    expect(ideaSourceNames(sources)[2]).toBe("“Check the export”");
  });

  it("leaves out the starter marker", () => {
    expect(ideaBasis([{ kind: "starter", label: "Starter idea" }])).toBeNull();
    expect(
      ideaBasis([
        { kind: "starter", label: "Starter idea" },
        { kind: "file", label: "File · notes.md" },
      ]),
    ).toBe("Based on notes.md");
  });
});

describe("ideasInGroup", () => {
  it("lists For you ideas by section: threads, then projects, then tools", () => {
    const ideas = [
      { id: "tool", section: "tools" },
      { id: "starter", section: "starter" },
      { id: "project", section: "projects" },
      { id: "thread", section: "continue" },
    ] as unknown as ReadonlyArray<Idea>;
    const [forYou, toTry] = IDEA_GROUPS;
    expect(ideasInGroup(ideas, forYou!).map((idea) => idea.id)).toEqual([
      "thread",
      "project",
      "tool",
    ]);
    expect(ideasInGroup(ideas, toTry!).map((idea) => idea.id)).toEqual(["starter"]);
  });
});
