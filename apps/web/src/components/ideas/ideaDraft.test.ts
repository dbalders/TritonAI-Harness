import { describe, expect, it } from "vite-plus/test";
import { mergeIdeaPrompt } from "./ideaDraft";

describe("mergeIdeaPrompt", () => {
  it("fills an empty composer with the idea's prompt", () => {
    expect(mergeIdeaPrompt("  \n", "Summarize this thread.")).toBe("Summarize this thread.");
  });

  it("keeps what the user already typed and adds the prompt after it", () => {
    expect(mergeIdeaPrompt("Draft for Maria\n", "Summarize this thread.")).toBe(
      "Draft for Maria\n\nSummarize this thread.",
    );
  });

  it("does not paste the same prompt twice", () => {
    const once = mergeIdeaPrompt("", "Summarize this thread.");
    expect(mergeIdeaPrompt(once, "Summarize this thread.")).toBe(once);
  });
});
