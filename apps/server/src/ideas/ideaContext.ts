/**
 * What the idea generator is shown, and how its answer is checked.
 *
 * Every item in the context carries a reference id (`thread:<id>`,
 * `note:<day>`, `file:<project>:<path>`, `plugin:<id>`, `skill:<id>`,
 * `starter:<id>`). The model must point each idea at those ids, and an idea
 * whose references are not in the context is dropped, so a card never cites
 * something that does not exist. Labels and sections come from the context,
 * not from the model.
 */
import {
  type IdeaAction,
  type IdeaSection,
  type IdeaSource,
  type IdeaSourceKind,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import type { GeneratedIdea } from "../textGeneration/TextGeneration.ts";
import { ideaKey, refKind, similarTitles } from "./ideaRules.ts";
import type { StarterIdea } from "./starterIdeas.ts";

export interface ContextProject {
  readonly id: string;
  readonly title: string;
}

export interface ContextThread {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly updatedAt: string;
  readonly status: "waiting on you" | "settled" | "snoozed" | "active";
  readonly lastUserMessage: string | null;
  readonly lastReply: string | null;
}

export interface ContextNote {
  /** `YYYY-MM-DD` */
  readonly day: string;
  readonly text: string;
}

export interface ContextFile {
  readonly projectId: string;
  /** Relative to the project folder, with `/` separators. */
  readonly path: string;
  readonly modifiedAt: string;
}

export interface ContextPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tools: ReadonlyArray<string>;
  readonly connected: boolean;
  readonly isNew: boolean;
}

export interface ContextSkill {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly isNew: boolean;
}

export interface IdeasContext {
  /** `YYYY-MM-DD` */
  readonly today: string;
  readonly weights: Record<IdeaSection, number>;
  readonly projects: ReadonlyArray<ContextProject>;
  readonly threads: ReadonlyArray<ContextThread>;
  readonly notes: ReadonlyArray<ContextNote>;
  readonly files: ReadonlyArray<ContextFile>;
  readonly plugins: ReadonlyArray<ContextPlugin>;
  readonly skills: ReadonlyArray<ContextSkill>;
  readonly starters: ReadonlyArray<StarterIdea>;
  /** Titles already shown, dismissed, rejected, or used. */
  readonly avoid: ReadonlyArray<string>;
}

/** An idea ready to store: checked, labeled, and keyed. */
export interface CandidateIdea {
  readonly key: string;
  readonly section: IdeaSection;
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  readonly sources: ReadonlyArray<IdeaSource>;
  readonly action: IdeaAction;
}

interface RefInfo {
  readonly kind: IdeaSourceKind;
  readonly label: string;
  readonly section: IdeaSection;
  readonly projectId: string | null;
  readonly threadId: string | null;
}

const SECTION_ICONS: Record<IdeaSection, string> = {
  continue: "🔁",
  projects: "📁",
  tools: "🧰",
  new: "✨",
  starter: "💡",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(day: string): string {
  const [, month, date] = day.split("-");
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} ${Number(date)}` : day;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function fileRef(file: Pick<ContextFile, "projectId" | "path">): string {
  return `file:${file.projectId}:${file.path}`;
}

function buildRefIndex(context: IdeasContext): ReadonlyMap<string, RefInfo> {
  const refs = new Map<string, RefInfo>();
  for (const thread of context.threads) {
    refs.set(`thread:${thread.id}`, {
      kind: "thread",
      label: `Thread · ${thread.title}`,
      section: "continue",
      projectId: thread.projectId,
      threadId: thread.id,
    });
  }
  for (const note of context.notes) {
    refs.set(`note:${note.day}`, {
      kind: "note",
      label: `Note · ${dayLabel(note.day)}`,
      section: "continue",
      projectId: null,
      threadId: null,
    });
  }
  for (const file of context.files) {
    refs.set(fileRef(file), {
      kind: "file",
      label: `File · ${fileName(file.path)}`,
      section: "projects",
      projectId: file.projectId,
      threadId: null,
    });
  }
  for (const plugin of context.plugins) {
    refs.set(`plugin:${plugin.id}`, {
      kind: "plugin",
      label: `Plugin · ${plugin.name}`,
      section: plugin.isNew ? "new" : "tools",
      projectId: null,
      threadId: null,
    });
  }
  for (const skill of context.skills) {
    refs.set(`skill:${skill.id}`, {
      kind: "skill",
      label: `Skill · ${skill.title}`,
      section: skill.isNew ? "new" : "tools",
      projectId: null,
      threadId: null,
    });
  }
  for (const starter of context.starters) {
    refs.set(`starter:${starter.id}`, {
      kind: "starter",
      label: "Starter idea",
      section: "starter",
      projectId: null,
      threadId: null,
    });
  }
  return refs;
}

export function formatIdeasContext(context: IdeasContext): string {
  const lines: string[] = [`Today is ${context.today}.`, ""];
  lines.push(
    "Preference weights (higher means the user responds more to that kind of idea):",
    `- own work (thread, note, file): ${Math.max(context.weights.continue, context.weights.projects)}`,
    `- tools (plugin, skill): ${context.weights.tools}`,
    `- new in TritonAI: ${context.weights.new}`,
    `- starter ideas: ${context.weights.starter}`,
    "",
  );

  lines.push("Projects (id: name):");
  if (context.projects.length === 0) lines.push("(none)");
  for (const project of context.projects) lines.push(`- ${project.id}: ${project.title}`);
  lines.push("");

  lines.push("Recent threads:");
  if (context.threads.length === 0) lines.push("(none)");
  for (const thread of context.threads) {
    lines.push(
      `- thread:${thread.id} "${clip(thread.title, 120)}" in project ${thread.projectId}; ${thread.status}; updated ${thread.updatedAt.slice(0, 10)}`,
    );
    if (thread.lastUserMessage) lines.push(`  last request: ${clip(thread.lastUserMessage, 400)}`);
    if (thread.lastReply) lines.push(`  last reply: ${clip(thread.lastReply, 400)}`);
  }
  lines.push("");

  lines.push("Daily notes from the user's memory:");
  if (context.notes.length === 0) lines.push("(none)");
  for (const note of context.notes) {
    lines.push(`### note:${note.day}`, note.text.trim().slice(0, 3_000), "");
  }
  lines.push("");

  lines.push("Recently changed files in the user's projects:");
  if (context.files.length === 0) lines.push("(none)");
  for (const file of context.files) {
    lines.push(`- ${fileRef(file)} (changed ${file.modifiedAt.slice(0, 10)})`);
  }
  lines.push("");

  lines.push("Plugins the user has turned on:");
  if (context.plugins.length === 0) lines.push("(none)");
  for (const plugin of context.plugins) {
    const tools = plugin.tools.length > 0 ? ` Tools: ${plugin.tools.join(", ")}.` : "";
    const state = plugin.connected ? "connected" : "needs sign-in first";
    const fresh = plugin.isNew ? "; new to this user" : "";
    lines.push(
      `- plugin:${plugin.id} ${plugin.name}: ${clip(plugin.description, 200)}${tools} (${state}${fresh})`,
    );
  }
  lines.push("");

  lines.push("Skills in the TritonAI catalog:");
  if (context.skills.length === 0) lines.push("(none)");
  for (const skill of context.skills) {
    const fresh = skill.isNew ? " (new this week)" : "";
    lines.push(`- skill:${skill.id} ${skill.title}: ${clip(skill.description, 200)}${fresh}`);
  }
  lines.push("");

  lines.push("Starter ideas (for anyone, adapt to the user when you can):");
  if (context.starters.length === 0) lines.push("(none)");
  for (const starter of context.starters) {
    lines.push(`- starter:${starter.id} ${starter.title}`);
  }
  lines.push("");

  lines.push("Avoid (already shown, dismissed, rejected, or used):");
  if (context.avoid.length === 0) lines.push("(none)");
  // The model sees a bounded hint; validation still checks the entire permanent history.
  for (const title of context.avoid.slice(0, 60)) lines.push(`- ${title}`);

  return lines.join("\n");
}

function isEmoji(icon: string): boolean {
  return icon.length > 0 && icon.length <= 16 && /\p{Extended_Pictographic}/u.test(icon);
}

/** A starter idea as a card, word for word. */
export function starterCandidate(starter: StarterIdea): CandidateIdea {
  return {
    key: `starter:${starter.id}`,
    section: "starter",
    icon: starter.icon,
    title: starter.title,
    body: starter.body,
    sources: [{ kind: "starter", label: "Starter idea" }],
    action: { kind: "new-thread", projectId: null, prompt: starter.prompt },
  };
}

/**
 * Turns the model's ideas into storable ones. Drops any idea that points at a
 * reference the context does not have, repeats an excluded key, or says nearly
 * the same thing as an avoided title or an earlier idea in the batch.
 */
export function validateGeneratedIdeas(input: {
  readonly ideas: ReadonlyArray<GeneratedIdea>;
  readonly context: IdeasContext;
  readonly excludedKeys: ReadonlySet<string>;
}): CandidateIdea[] {
  const refs = buildRefIndex(input.context);
  const projectIds = new Set(input.context.projects.map((project) => project.id));
  const accepted: CandidateIdea[] = [];
  const keys = new Set(input.excludedKeys);
  const titles = [...input.context.avoid];
  for (const idea of input.ideas) {
    const primary = refs.get(idea.ref);
    if (!primary || refKind(idea.ref) === null) continue;
    const title = clip(idea.title, 100);
    const body = clip(idea.body, 300);
    const prompt = idea.prompt.trim().slice(0, 4_000);
    if (title.length === 0 || body.length === 0 || prompt.length === 0) continue;
    const key = ideaKey(idea.ref, idea.topic);
    if (keys.has(key) || titles.some((other) => similarTitles(other, title))) continue;

    const sources: IdeaSource[] = [];
    for (const ref of [idea.ref, ...idea.sources]) {
      const info = refs.get(ref);
      if (!info || sources.some((source) => source.label === info.label)) continue;
      sources.push({ kind: info.kind, label: info.label });
    }
    const action: IdeaAction =
      idea.action === "resume-thread" && primary.threadId !== null
        ? { kind: "resume-thread", threadId: ThreadId.make(primary.threadId), prompt }
        : {
            kind: "new-thread",
            projectId: projectIds.has(idea.projectId)
              ? ProjectId.make(idea.projectId)
              : primary.projectId !== null
                ? ProjectId.make(primary.projectId)
                : null,
            prompt,
          };

    keys.add(key);
    titles.push(title);
    accepted.push({
      key,
      section: primary.section,
      icon: isEmoji(idea.icon) ? idea.icon : SECTION_ICONS[primary.section],
      title,
      body,
      sources,
      action,
    });
  }
  return accepted;
}
