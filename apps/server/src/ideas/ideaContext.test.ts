import { describe, expect, it } from "vite-plus/test";

import type { GeneratedIdea } from "../textGeneration/TextGeneration.ts";
import { formatIdeasContext, type IdeasContext, validateGeneratedIdeas } from "./ideaContext.ts";
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
  it("labels sources and picks the section from the context, not the model", () => {
    const [accepted] = validateGeneratedIdeas({
      ideas: [idea({ sources: ["note:2026-10-12", "thread:thread-1", "skill:unknown"] })],
      context: CONTEXT,
      excludedKeys: new Set(),
    });
    expect(accepted).toMatchObject({
      key: "thread:thread-1",
      section: "continue",
      sources: [
        { kind: "thread", label: "Thread · Q1 travel reconciliation" },
        { kind: "note", label: "Note · Oct 12" },
      ],
      action: { kind: "resume-thread", threadId: "thread-1" },
    });
  });

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

  it("drops excluded keys, avoided titles, and repeats within the batch", () => {
    const accepted = validateGeneratedIdeas({
      ideas: [
        idea({}),
        idea({ ref: "note:2026-10-12", title: "I can summarize your long email chain" }),
        idea({ ref: "plugin:lucid", topic: "diagram", title: "I can draw your onboarding flow" }),
        idea({ ref: "plugin:lucid", topic: "diagram", title: "I can map the approval process" }),
      ],
      context: CONTEXT,
      excludedKeys: new Set(["thread:thread-1"]),
    });
    expect(accepted.map((entry) => entry.title)).toEqual(["I can draw your onboarding flow"]);
  });

  it("opens new work in the referenced file's project unless the model names another", () => {
    const [fromFile, fromPlugin] = validateGeneratedIdeas({
      ideas: [
        idea({
          ref: "file:project-1:data/FY26 budget.xlsx",
          title: "I can summarize the FY26 budget by department",
          action: "resume-thread",
        }),
        idea({
          ref: "plugin:lucid",
          topic: "diagram approvals",
          title: "I can diagram your approval flow",
          action: "new-thread",
          icon: "not an emoji",
        }),
      ],
      context: CONTEXT,
      excludedKeys: new Set(),
    });
    expect(fromFile).toMatchObject({
      section: "projects",
      action: { kind: "new-thread", projectId: "project-1" },
      sources: [{ kind: "file", label: "File · FY26 budget.xlsx" }],
    });
    expect(fromFile?.subject).toBe("project:project-1");
    expect(fromPlugin).toMatchObject({
      section: "tools",
      icon: "🧰",
      subject: "plugin:lucid",
      action: { kind: "new-thread", projectId: null },
    });
  });

  it("drops ideas that leave a blank for the user or cite a starter instead of real work", () => {
    expect(
      validateGeneratedIdeas({
        ideas: [
          idea({ prompt: "Turn these notes into an email.\n\nNotes:\n[paste your notes here]" }),
          idea({
            ref: "plugin:lucid",
            topic: "diagram",
            title: "I can diagram a process",
            prompt: "Diagram the <your process name> process in Lucid.",
          }),
          idea({
            ref: "note:2026-10-12",
            title: "I can draft the vendor email",
            body: "Paste the list and I'll write it.",
            prompt: "Email {{recipient}} the vendor list.",
          }),
          idea({ ref: "starter:meeting-follow-up", title: "I can write a follow-up email" }),
        ],
        context: CONTEXT,
        excludedKeys: new Set(),
      }),
    ).toEqual([]);
    const [linked] = validateGeneratedIdeas({
      ideas: [
        idea({ prompt: "Match the remaining lines using [the guide](https://example.edu/guide)." }),
      ],
      context: CONTEXT,
      excludedKeys: new Set(),
    });
    expect(linked?.title).toBe("I can finish the Q1 travel reconciliation");
  });

  it("files a skill new to this user under New in TritonAI", () => {
    const [accepted] = validateGeneratedIdeas({
      ideas: [
        idea({
          ref: "skill:ucsd-decorator",
          title: "I can brand your grant memo",
          action: "new-thread",
        }),
      ],
      context: CONTEXT,
      excludedKeys: new Set(),
    });
    expect(accepted?.section).toBe("new");
  });
});

describe("formatIdeasContext", () => {
  it("gives every item the reference id the model must cite", () => {
    const text = formatIdeasContext(CONTEXT);
    for (const ref of [
      "thread:thread-1",
      "note:2026-10-12",
      "file:project-1:data/FY26 budget.xlsx",
      "plugin:lucid",
      "skill:ucsd-decorator",
    ]) {
      expect(text).toContain(ref);
    }
    expect(text).not.toContain("starter:");
    expect(text).toContain(`- ${IDEA_KINDS[0]}`);
    expect(text).toContain("- I can summarize a long email chain");
  });
});
