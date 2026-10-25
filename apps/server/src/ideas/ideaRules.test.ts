import type { IdeaSection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  capBySubject,
  needsUserInput,
  ideaKey,
  sectionWeights,
  selectByMix,
  similarTitles,
} from "./ideaRules.ts";

const EVEN: Record<IdeaSection, number> = {
  continue: 1,
  projects: 1,
  tools: 1,
  new: 1,
  starter: 1,
};

const ideas = (...sections: IdeaSection[]) =>
  sections.map((section, index) => ({ section, name: `${section}-${index}` }));

describe("ideaKey", () => {
  it("tells apart ideas from the same note or plugin by topic", () => {
    expect(ideaKey("note:2026-10-12", "Draft the budget email!")).toBe(
      "note:2026-10-12#draft-the-budget-email",
    );
    expect(ideaKey("plugin:lucid", "Diagram onboarding")).not.toBe(
      ideaKey("plugin:lucid", "Diagram the approval flow"),
    );
  });
});

describe("similarTitles", () => {
  it("catches a reworded repeat", () => {
    expect(
      similarTitles(
        "I can turn meeting notes into a follow-up email",
        "Let me turn your meeting notes into a follow-up email",
      ),
    ).toBe(true);
  });

  it("keeps different ideas apart even when they share filler words", () => {
    expect(
      similarTitles("I can chart your enrollment numbers", "I can draft your vendor email"),
    ).toBe(false);
  });
});

describe("sectionWeights", () => {
  it("raises sections the user acts on and lowers ones they push away", () => {
    const weights = sectionWeights(
      new Map([
        ["continue", { opened: 3, sent: 2, dismissed: 0, lessLikeThis: 0 }],
        ["tools", { opened: 0, sent: 0, dismissed: 2, lessLikeThis: 1 }],
      ]),
    );
    expect(weights.continue).toBeGreaterThan(1);
    expect(weights.tools).toBeLessThan(1);
    expect(weights.starter).toBe(1);
  });

  it("never drops a section to zero", () => {
    const weights = sectionWeights(
      new Map([["new", { opened: 0, sent: 0, dismissed: 20, lessLikeThis: 10 }]]),
    );
    expect(weights.new).toBe(0.2);
  });
});

describe("selectByMix", () => {
  it("keeps at least two discovery ideas when the user's own work could fill the batch", () => {
    const picked = selectByMix(
      ideas("continue", "continue", "continue", "projects", "projects", "tools", "starter"),
      6,
      EVEN,
    );
    expect(picked).toHaveLength(6);
    expect(
      picked.filter((idea) => idea.section === "tools" || idea.section === "starter"),
    ).toHaveLength(2);
  });

  it("fills from the other side when one side runs short", () => {
    expect(
      selectByMix(ideas("continue", "continue", "projects", "continue"), 3, EVEN),
    ).toHaveLength(3);
    expect(selectByMix(ideas("starter", "starter", "tools", "new"), 4, EVEN)).toHaveLength(4);
  });

  it("gives the open slot to the section the user favors", () => {
    const picked = selectByMix(
      ideas("continue", "continue", "continue", "continue", "tools", "tools", "tools"),
      6,
      { ...EVEN, continue: 2.5 },
    );
    expect(picked.filter((idea) => idea.section === "continue")).toHaveLength(4);
  });
});

describe("needsUserInput", () => {
  it("finds blanks left for the user", () => {
    expect(needsUserInput("Meeting notes:\n[paste your notes here]")).toBe(true);
    expect(needsUserInput("Review <your file name> for errors.")).toBe(true);
    expect(needsUserInput("Email {{name}} today.")).toBe(true);
    expect(needsUserInput("Due date: ____")).toBe(true);
  });

  it("finds requests for input that use no placeholder", () => {
    expect(needsUserInput("Ask me to paste the meeting notes, then summarize them.")).toBe(true);
    expect(needsUserInput("Paste the list and I'll write the email.")).toBe(true);
    expect(needsUserInput("If there isn't enough detail, ask me for three topics.")).toBe(true);
  });

  it("allows complete prompts, including Markdown links", () => {
    expect(needsUserInput("Draft the fix, but ask me before changing anything.")).toBe(false);
    expect(needsUserInput("Review app/[id]/page.tsx for errors.")).toBe(false);
    expect(needsUserInput("Fix the values[0] access in report.ts.")).toBe(false);
    expect(needsUserInput("Check matrix[i + 1] bounds in grid.py.")).toBe(false);
    expect(needsUserInput("Compare course_main.csv with the October export.")).toBe(false);
    expect(needsUserInput("Follow [the guide](https://example.edu/guide) to rerun it.")).toBe(
      false,
    );
  });
});

describe("capBySubject", () => {
  it("keeps any one subject to two visible ideas, counting what is already showing", () => {
    const candidates = [
      { subject: "project:p1", name: "a" },
      { subject: "project:p1", name: "b" },
      { subject: "plugin:n8n", name: "c" },
      { subject: "plugin:n8n", name: "d" },
      { subject: "plugin:n8n", name: "e" },
    ];
    expect(capBySubject(candidates, ["project:p1"]).map((entry) => entry.name)).toEqual([
      "a",
      "c",
      "d",
    ]);
  });
});
