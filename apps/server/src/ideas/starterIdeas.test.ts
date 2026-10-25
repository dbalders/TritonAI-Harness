import { describe, expect, it } from "vite-plus/test";

import { needsUserInput } from "./ideaRules.ts";
import { availableStarters, STARTER_IDEAS } from "./starterIdeas.ts";

describe("starter ideas", () => {
  it("can all be sent as written", () => {
    for (const starter of STARTER_IDEAS) {
      expect(needsUserInput(starter.prompt), starter.id).toBe(false);
      expect(needsUserInput(starter.body), starter.id).toBe(false);
      expect(starter.prompt, starter.id).not.toMatch(/\bpaste\b/iu);
    }
    expect(new Set(STARTER_IDEAS.map((starter) => starter.id)).size).toBe(STARTER_IDEAS.length);
  });

  it("offers plugin ideas only once that plugin is connected", () => {
    const general = availableStarters(new Set());
    expect(general.every((starter) => starter.requires === undefined)).toBe(true);
    // A first visit and one Suggest more must have enough to show without any plugin.
    expect(general.length).toBeGreaterThanOrEqual(10);
    const withMail = availableStarters(new Set(["microsoft-365"]));
    expect(withMail[0]?.requires).toBe("microsoft-365");
    expect(withMail.some((starter) => starter.requires === "github")).toBe(false);
  });
});
