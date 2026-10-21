/**
 * The rules that decide which ideas a user sees: what makes two ideas the
 * same, how feedback moves the mix of sections, and how a batch is split
 * between the user's own work and discovery.
 */
import type { IdeaSection, IdeaSourceKind } from "@t3tools/contracts";

export const IDEA_SECTIONS: ReadonlyArray<IdeaSection> = [
  "continue",
  "projects",
  "tools",
  "new",
  "starter",
];

/** Sections built from the user's own threads, notes, and files. The rest are discovery. */
function isPersonalSection(section: IdeaSection): boolean {
  return section === "continue" || section === "projects";
}

const REF_KINDS: ReadonlyArray<IdeaSourceKind> = [
  "thread",
  "note",
  "file",
  "plugin",
  "skill",
  "starter",
];

/** The kind named by a context reference such as `thread:abc`, or null when it is not one. */
export function refKind(ref: string): IdeaSourceKind | null {
  const prefix = ref.slice(0, ref.indexOf(":"));
  return REF_KINDS.find((kind) => kind === prefix) ?? null;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
}

/**
 * What an idea is about, independent of its wording. A thread, file, skill, or
 * starter idea is one idea; a note or plugin can carry several, told apart by
 * topic.
 */
export function ideaKey(ref: string, topic: string): string {
  const kind = refKind(ref);
  if (kind === "note" || kind === "plugin") {
    const topicSlug = slug(topic);
    return topicSlug.length > 0 ? `${ref}#${topicSlug}` : ref;
  }
  return ref;
}

// Words every idea title shares, which would make unrelated titles look alike.
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "can",
  "for",
  "from",
  "i",
  "i'll",
  "in",
  "into",
  "it",
  "let",
  "me",
  "my",
  "of",
  "on",
  "the",
  "to",
  "with",
  "you",
  "your",
]);

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .filter((word) => word.length > 0 && !STOP_WORDS.has(word)),
  );
}

// Blanks left for the user: `[your notes]` (but not a Markdown link), `<your file>`, `{{name}}`, `___`.
const PLACEHOLDER = /\[[^\]\n]+\](?!\()|<[^<>\n]*\byour\b[^<>\n]*>|\{\{[^}\n]*\}\}|_{3,}/iu;

/**
 * Whether text leaves something for the user to fill in. An idea must be ready
 * to send as written, so a card with a blank is never shown.
 */
export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

/** At most this many visible ideas may be about the same project or the same tool. */
const MAX_IDEAS_PER_SUBJECT = 2;

/**
 * What an idea is about for variety's sake: its project when it has one,
 * otherwise what its key names without the topic, such as `plugin:n8n`.
 */
export function ideaSubject(key: string, projectId: string | null): string {
  if (projectId !== null) return `project:${projectId}`;
  const topic = key.indexOf("#");
  return topic === -1 ? key : key.slice(0, topic);
}

/**
 * Keeps candidates in order while no subject goes past the limit, counting the
 * ideas already on the page, so one busy project can't fill the page.
 */
export function capBySubject<T extends { readonly subject: string }>(
  candidates: ReadonlyArray<T>,
  visibleSubjects: ReadonlyArray<string>,
  limit: number = MAX_IDEAS_PER_SUBJECT,
): T[] {
  const counts = new Map<string, number>();
  for (const subject of visibleSubjects) counts.set(subject, (counts.get(subject) ?? 0) + 1);
  const kept: T[] = [];
  for (const candidate of candidates) {
    const count = counts.get(candidate.subject) ?? 0;
    if (count >= limit) continue;
    counts.set(candidate.subject, count + 1);
    kept.push(candidate);
  }
  return kept;
}

/** Whether two titles say nearly the same thing, so a reworded repeat is caught. */
export function similarTitles(left: string, right: string): boolean {
  const a = titleWords(left);
  const b = titleWords(right);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared) >= 0.6;
}

export interface SectionFeedback {
  readonly opened: number;
  readonly sent: number;
  readonly dismissed: number;
  readonly lessLikeThis: number;
}

/**
 * How much each section is favored, from 0.2 to 3. Opening and using ideas
 * raises a section; dismissing lowers it a little and "Less like this" a lot.
 */
export function sectionWeights(
  feedback: ReadonlyMap<IdeaSection, SectionFeedback>,
): Record<IdeaSection, number> {
  const weights = {} as Record<IdeaSection, number>;
  for (const section of IDEA_SECTIONS) {
    const counts = feedback.get(section);
    const raw = counts
      ? 1 +
        0.2 * counts.opened +
        0.4 * counts.sent -
        0.15 * counts.dismissed -
        0.6 * counts.lessLikeThis
      : 1;
    weights[section] = Math.min(3, Math.max(0.2, Math.round(raw * 100) / 100));
  }
  return weights;
}

/**
 * Picks up to `slots` ideas, keeping the batch balanced: at least two discovery
 * ideas, roughly half from the user's own work, and the rest to whichever
 * sections the user responds to most. Within a section the given order wins.
 * Missing discovery ideas are made up from personal ones and the other way round.
 */
export function selectByMix<T extends { readonly section: IdeaSection }>(
  candidates: ReadonlyArray<T>,
  slots: number,
  weights: Record<IdeaSection, number>,
): T[] {
  if (slots <= 0) return [];
  const ranked = candidates
    .map((candidate, index) => ({
      candidate,
      score: weights[candidate.section] - index * 0.001,
    }))
    .toSorted((left, right) => right.score - left.score)
    .map((entry) => entry.candidate);
  const discoveryMin = Math.min(2, slots);
  const personalCap = Math.ceil(slots / 2);
  const personalMax = slots - discoveryMin;
  const picked = new Set<T>();
  const count = (personal: boolean) =>
    [...picked].filter((idea) => isPersonalSection(idea.section) === personal).length;

  for (const idea of ranked) {
    if (count(false) >= discoveryMin) break;
    if (!isPersonalSection(idea.section)) picked.add(idea);
  }
  for (const idea of ranked) {
    if (count(true) >= personalCap || picked.size >= slots) break;
    if (isPersonalSection(idea.section)) picked.add(idea);
  }
  for (const idea of ranked) {
    if (picked.size >= slots) break;
    if (picked.has(idea)) continue;
    const personal = isPersonalSection(idea.section);
    // The personal limit only binds while discovery ideas are left to take its place.
    const discoveryLeft = ranked.some(
      (other) => !picked.has(other) && !isPersonalSection(other.section),
    );
    if (personal && count(true) >= personalMax && discoveryLeft) continue;
    picked.add(idea);
  }
  return ranked.filter((idea) => picked.has(idea));
}
