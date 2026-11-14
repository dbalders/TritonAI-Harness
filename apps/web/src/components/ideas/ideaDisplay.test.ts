import { describe, expect, it } from "vite-plus/test";
import type { Idea } from "@t3tools/contracts";
import {
  featureIdeas,
  IDEA_GROUPS,
  ideaBasis,
  ideaHeadline,
  ideasInGroup,
  ideaSourceNames,
} from "./ideaDisplay";

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

describe("featureIdeas", () => {
  const feature = (id: string, snoozedUntil: string | null = null) =>
    ({
      id,
      section: "feature",
      icon: "👥",
      title: `Try ${id}`,
      body: "A feature to try.",
      sources: [],
      action: { kind: "new-thread", projectId: null, prompt: `Show me ${id}.` },
      createdAt: "2026-10-28T12:00:00.000Z",
      openedAt: null,
      draftThreadIds: [],
      snoozedUntil,
    }) as unknown as Idea;

  it("splits cards to try from snoozed ones and drops hidden cards", () => {
    const { toTry, snoozed } = featureIdeas(
      [feature("subagents"), feature("charts", "2026-10-29T09:00:00.000Z"), feature("threads")],
      new Set(["threads"]),
    );
    expect(toTry.map((idea) => idea.id)).toEqual(["subagents"]);
    expect(snoozed.map((idea) => idea.id)).toEqual(["charts"]);
  });

  it("is empty when the server sends no feature cards", () => {
    expect(featureIdeas(undefined, new Set())).toEqual({ toTry: [], snoozed: [] });
  });
});
