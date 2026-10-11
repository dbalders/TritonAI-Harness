import { describe, expect, it } from "vite-plus/test";

import { rewriteTritonAiFeedbackCommand } from "./tritonAiFeedback.ts";

describe("rewriteTritonAiFeedbackCommand", () => {
  it("mentions the feedback skill in place of a leading /feedback", () => {
    expect(rewriteTritonAiFeedbackCommand("/feedback")).toBe("$tritonai-feedback");
    expect(rewriteTritonAiFeedbackCommand(" /Feedback\nThe agent stopped early.")).toBe(
      " $tritonai-feedback\nThe agent stopped early.",
    );
  });

  it("leaves other commands and ordinary messages unchanged", () => {
    for (const prompt of [
      "/openai-feedback The agent stopped early.",
      "/feedback-status",
      "Please send /feedback",
    ]) {
      expect(rewriteTritonAiFeedbackCommand(prompt)).toBe(prompt);
    }
  });
});
