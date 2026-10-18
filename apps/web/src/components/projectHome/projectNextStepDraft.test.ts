import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  IsoDateTime,
  ProviderInstanceId,
  ThreadId,
  type ProjectOverview,
} from "@t3tools/contracts";
import { projectNextStepDraft } from "./projectNextStepDraft";
import { mergeIdeaPrompt } from "../ideas/ideaDraft";

describe("project next-step draft", () => {
  it("opens the selected action with source-thread references instead of pasting history", () => {
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
          prompt: "A long generated instruction that should not become the user's request.",
          sources: ["thread:one", "note:project-memory"],
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
        {
          ref: "note:project-memory",
          title: "Project history",
          threadId: null,
          text: "Background notes should not be pasted into the message either.",
        },
      ],
    };
    const { prompt, threadContexts } = projectNextStepDraft(
      EnvironmentId.make("project-environment"),
      overview,
      overview.nextSteps[0]!,
    );
    expect(prompt).toBe("Review checklist");
    expect(threadContexts).toEqual([
      expect.objectContaining({
        kind: "thread",
        environmentId: "project-environment",
        threadId: "one",
        title: "Checklist",
      }),
    ]);
    expect(JSON.stringify(threadContexts)).not.toContain("The checklist is a draft.");
    const merged = mergeIdeaPrompt("Keep my existing request.", prompt);
    expect(merged).toContain("Keep my existing request.");
    expect(mergeIdeaPrompt(merged, prompt)).toBe(merged);
  });
});
