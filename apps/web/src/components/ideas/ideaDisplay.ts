/**
 * How an idea reads on the Ideas page: its title as a task, and one short line
 * saying what it is based on.
 */
import type { Idea, IdeaSection, IdeaSource } from "@t3tools/contracts";

export interface IdeaGroup {
  readonly id: string;
  readonly title: string;
  readonly sections: ReadonlyArray<IdeaSection>;
  /** Rows shown before "Show more". */
  readonly initialCount: number;
}

/** The user's own work first, then things to try. */
export const IDEA_GROUPS: ReadonlyArray<IdeaGroup> = [
  { id: "for-you", title: "For you", sections: ["continue", "projects", "tools"], initialCount: 4 },
  { id: "to-try", title: "Things to try", sections: ["new", "starter"], initialCount: 3 },
];

/** The group's ideas, in the order of its sections, keeping the server's order within each. */
export function ideasInGroup(ideas: ReadonlyArray<Idea>, group: IdeaGroup): ReadonlyArray<Idea> {
  return group.sections.flatMap((section) => ideas.filter((idea) => idea.section === section));
}

// Ideas written before titles became tasks start with an offer: "I can …".
const OFFER_PREFIX = /^\s*I can\s+/iu;

/** The idea's title as the task itself. */
export function ideaHeadline(title: string): string {
  const task = title.replace(OFFER_PREFIX, "");
  if (task === title || task.length === 0) return title;
  return task.charAt(0).toUpperCase() + task.slice(1);
}

const KIND_PREFIX = /^(?:Thread|Note|File|Plugin|Skill) · /u;

function sourceName(source: IdeaSource): string {
  const name = source.label.replace(KIND_PREFIX, "");
  if (source.kind === "note") return `${name} note`;
  if (source.kind === "thread") return `“${name}”`;
  return name;
}

/** Every source by name, leaving out the "Starter idea" marker. */
export function ideaSourceNames(sources: ReadonlyArray<IdeaSource>): ReadonlyArray<string> {
  return sources.filter((source) => source.kind !== "starter").map(sourceName);
}

/** "Based on n8n, Oct 13 note +1", or null when there is nothing to name. */
export function ideaBasis(sources: ReadonlyArray<IdeaSource>, shown = 2): string | null {
  const names = ideaSourceNames(sources);
  if (names.length === 0) return null;
  const more = names.length - shown;
  return `Based on ${names.slice(0, shown).join(", ")}${more > 0 ? ` +${more}` : ""}`;
}
