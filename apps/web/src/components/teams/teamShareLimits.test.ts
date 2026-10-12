import { expect, it } from "vite-plus/test";
import { shareLimitProblem } from "./teamShareLimits";

it("refuses text over 60,000 characters even when it fits in 64 KB", () => {
  const text = "a".repeat(61_000);
  expect(shareLimitProblem({ text, note: text })).toBe(
    "Shared text can be at most 60,000 characters; this has 61,000.",
  );
  expect(shareLimitProblem({ text: "a".repeat(60_000), note: "a".repeat(60_000) })).toBeNull();
});

it("refuses a note over 64 KB once formatted, even under 60,000 characters", () => {
  const text = "é".repeat(40_000);
  expect(shareLimitProblem({ text, note: text })).toBe("Shared notes must be smaller than 64 KB.");
});
