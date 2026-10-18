import { describe, expect, it } from "vite-plus/test";
import {
  IsoDateTime,
  ProviderInstanceId,
  ThreadId,
  type ProjectOverview,
} from "@t3tools/contracts";
import { projectNextStepDraft } from "./projectNextStepDraft";
import { mergeIdeaPrompt } from "../ideas/ideaDraft";

describe("project next-step draft", () => {
  it("carries only the selected evidence and preserves an existing draft without duplication", () => {
    const overview: ProjectOverview = {
      description: "A reviewed Teams pilot.",
      generatedAt: IsoDateTime.make("2026-10-17T12:00:00.000Z"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      sourceDigest: "digest",
      nextSteps: [
        {
          id: "review",
          title: "Review checklist",
          reason: "The draft needs review.",
          prompt: "Review the pilot checklist.",
          sources: ["thread:one"],
        },
      ],
      sources: [
        {
          ref: "thread:one",
          title: "Checklist",
          threadId: ThreadId.make("one"),
          text: "The checklist is a draft.",
        },
        {
          ref: "thread:two",
          title: "Other work",
          threadId: ThreadId.make("two"),
          text: "Unreferenced evidence",
        },
      ],
    };
    const prompt = projectNextStepDraft(overview, overview.nextSteps[0]!);
    expect(prompt).toContain("Review the pilot checklist.");
    expect(prompt).toContain("The checklist is a draft.");
    expect(prompt).toContain("2026-10-17T12:00:00.000Z");
    expect(prompt).not.toContain("Unreferenced evidence");
    const merged = mergeIdeaPrompt("Keep my existing request.", prompt);
    expect(merged).toContain("Keep my existing request.");
    expect(mergeIdeaPrompt(merged, prompt)).toBe(merged);
  });
});
