import { describe, expect, it } from "vite-plus/test";

import type { GeneratedIdea } from "../textGeneration/TextGeneration.ts";
import { type IdeasContext, validateGeneratedIdeas } from "./ideaContext.ts";
import { IDEA_KINDS } from "./starterIdeas.ts";

const CONTEXT: IdeasContext = {
  today: "2026-10-13",
  weights: { continue: 1, projects: 1, tools: 1, new: 1, starter: 1 },
  projects: [{ id: "project-1", title: "Budget Office" }],
  threads: [
    {
      id: "thread-1",
      title: "Q1 travel reconciliation",
      projectId: "project-1",
      updatedAt: "2026-10-10T18:00:00.000Z",
      status: "active",
      lastUserMessage: "Match the remaining travel lines.",
      lastReply: "41 of 58 lines are matched.",
    },
  ],
  notes: [{ day: "2026-10-12", text: "Open loops: send the vendor list to Maria." }],
  files: [{ projectId: "project-1", path: "data/FY26 budget.xlsx", modifiedAt: "2026-10-11" }],
  plugins: [
    {
      id: "lucid",
      name: "Lucid",
      description: "Diagrams in Lucidchart.",
      tools: ["Create diagram"],
      connected: true,
      isNew: false,
    },
  ],
  skills: [
    {
      id: "ucsd-decorator",
      title: "UCSD decorator",
      description: "Applies UC San Diego branding.",
      isNew: true,
    },
  ],
  kinds: IDEA_KINDS.slice(0, 3),
  avoid: ["I can summarize a long email chain"],
};

const idea = (overrides: Partial<GeneratedIdea>): GeneratedIdea => ({
  ref: "thread:thread-1",
  topic: "finish reconciliation",
  sources: [],
  icon: "🧾",
  title: "I can finish the Q1 travel reconciliation",
  body: "You stopped with 41 of 58 lines matched. I can match the rest.",
  action: "resume-thread",
  projectId: "",
  prompt: "Please match the remaining travel lines and list the ones you could not match.",
  ...overrides,
});

describe("validateGeneratedIdeas", () => {
  it("drops ideas about things the context does not contain", () => {
    expect(
      validateGeneratedIdeas({
        ideas: [
          idea({ ref: "thread:invented" }),
          idea({ ref: "file:project-1:secret.xlsx", title: "I can chart the secret file" }),
          idea({ ref: "made-up", title: "Something else entirely" }),
        ],
        context: CONTEXT,
        excludedKeys: new Set(),
      }),
    ).toEqual([]);
  });
});
