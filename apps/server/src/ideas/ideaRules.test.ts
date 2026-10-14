import type { IdeaSection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ideaKey, sectionWeights, selectByMix, similarTitles } from "./ideaRules.ts";

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
  it("names one idea per thread, file, skill, or starter, whatever its topic", () => {
    expect(ideaKey("thread:t1", "finish the report")).toBe("thread:t1");
    expect(ideaKey("thread:t1", "chart the numbers")).toBe("thread:t1");
    expect(ideaKey("starter:brainstorm", "anything")).toBe("starter:brainstorm");
  });

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

  it("gives about half the batch to the user's own work", () => {
    const picked = selectByMix(
      ideas("continue", "continue", "continue", "continue", "tools", "new", "starter", "starter"),
      6,
      { ...EVEN, tools: 2, new: 2, starter: 2 },
    );
    expect(picked.filter((idea) => idea.section === "continue")).toHaveLength(3);
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
