import { describe, expect, it } from "vite-plus/test";

import { needsUserInput, similarTitles } from "./ideaRules.ts";

describe("similarTitles", () => {
  it("catches a reworded repeat", () => {
    expect(
      similarTitles(
        "I can turn meeting notes into a follow-up email",
        "Let me turn your meeting notes into a follow-up email",
      ),
    ).toBe(true);
  });
});

describe("needsUserInput", () => {
  it("finds blanks left for the user", () => {
    expect(needsUserInput("Meeting notes:\n[paste your notes here]")).toBe(true);
    expect(needsUserInput("Review <your file name> for errors.")).toBe(true);
    expect(needsUserInput("Email {{name}} today.")).toBe(true);
    expect(needsUserInput("Due date: ____")).toBe(true);
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
