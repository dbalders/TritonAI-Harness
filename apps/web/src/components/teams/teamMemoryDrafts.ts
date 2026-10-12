import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  TEAM_SKILL_PREAMBLE,
  type TeamContextKind,
  type TeamMemoryReference,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import {
  type ComposerThreadTarget,
  composerTargetKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { createMemoryStorage } from "../../lib/storage";
import { useQueuedMessageStore } from "../../queuedMessageStore";

/**
 * Unsent team memory and skills tracked at once. Beyond it a new one is refused; a live one is
 * never dropped.
 */
export const MAX_DRAFT_TEAM_MEMORY = 50;
const NO_ENTRIES: readonly DraftTeamMemory[] = [];
/** Note lines shorter than this are too common to attribute leftover text to a note. */
const MIN_NOTE_LINE = 8;

/**
 * Team memory or a team skill inserted into one thread's unsent draft. The text lives in the
 * draft like any other text; this record is what lets the server recheck the reference before
 * sending and lets the client remove the text when the campus account changes.
 */
export interface DraftTeamMemory extends TeamMemoryReference {
  readonly thread: ComposerThreadTarget;
  readonly environmentId: EnvironmentId;
  /** `issuer:subject` of the campus account the reference was issued to. */
  readonly identity: string;
}

interface DraftTeamMemoryState {
  readonly entries: readonly DraftTeamMemory[];
  /** Why the last send was refused, per draft; cleared by a passing check or removal. */
  readonly problems: Readonly<Record<string, string>>;
}

const header = (block: string) => block.slice(0, block.indexOf("\n"));
const closingTag = (block: string) => block.slice(block.lastIndexOf("\n") + 1);
/** Lines that came from the note itself; the preamble every skill block shares is not one. */
const noteLines = (block: string) =>
  block
    .split("\n")
    .slice(1, -1)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_NOTE_LINE && line !== TEAM_SKILL_PREAMBLE);
const draftTeamContextKind = (entry: DraftTeamMemory): TeamContextKind => entry.kind ?? "memory";

function nextOpeningTag(text: string, from: number): number {
  const pattern = /<team-(?:memory|skill)[\s>]/gu;
  pattern.lastIndex = from;
  return pattern.exec(text)?.index ?? -1;
}

/** A closing tag with no opening tag before it, left behind when an attribution line was deleted. */
function hasOrphanClosingTag(text: string): boolean {
  let open = false;
  for (const match of text.matchAll(/<(\/?)team-(?:memory|skill)[\s>]/gu)) {
    if (!match[1]) open = true;
    else if (!open) return true;
    else open = false;
  }
  return false;
}

/** Whether text left after removal still carries part of a note: its path, a line, or a stray tag. */
function leftoverOf(text: string): (block: string) => boolean {
  const lines = new Set(text.split("\n").map((line) => line.trim()));
  const orphanClosingTag = hasOrphanClosingTag(text);
  return (block) => {
    const note = /(?:note|skill)="([^"]+)"/u.exec(header(block))?.[1];
    return (
      orphanClosingTag ||
      (note !== undefined && text.includes(note)) ||
      noteLines(block).some((line) => lines.has(line))
    );
  };
}

/**
 * Removes inserted team memory and skill blocks and keeps the rest of the text. A block goes when it is
 * unchanged, or from its attribution line through the first closing tag before any other block
 * starts. A block whose end can't be found, or whose attribution line was edited away while its
 * text remains, stays and is reported as unresolved: removing more could delete the user's own
 * text, and removing less would leave team text looking like the user's.
 */
export function removeTeamMemoryBlocks(
  prompt: string,
  blocks: readonly string[],
): { prompt: string; unresolved: string[] } {
  let next = prompt;
  const openEnded = new Set<string>();
  for (const block of blocks) {
    const opening = header(block);
    let from = 0;
    for (;;) {
      const start = next.indexOf(opening, from);
      if (start < 0) break;
      let end = start + block.length;
      if (!next.startsWith(block, start)) {
        const close = next.indexOf(closingTag(block), start + opening.length);
        const following = nextOpeningTag(next, start + opening.length);
        if (close < 0 || (following >= 0 && following < close)) {
          openEnded.add(block);
          from = start + opening.length;
          continue;
        }
        end = close + closingTag(block).length;
      }
      const before = next.slice(0, start);
      const after = next.slice(end);
      const kept = [before.trimEnd(), after.trimStart()] as const;
      const gap = /\n/u.test(
        before.slice(kept[0].length) + after.slice(0, after.length - kept[1].length),
      )
        ? "\n\n"
        : " ";
      next = kept[0] && kept[1] ? `${kept[0]}${gap}${kept[1]}` : kept[0] || kept[1];
      from = kept[0].length;
    }
  }
  const missing = blocks.filter((block) => !openEnded.has(block) && !next.includes(header(block)));
  const leftover = missing.length > 0 ? leftoverOf(next) : () => false;
  return {
    prompt: next,
    unresolved: blocks.filter(
      (block) => openEnded.has(block) || (missing.includes(block) && leftover(block)),
    ),
  };
}

type Presence = "tracked" | "unresolved" | "gone";

/** Where each of one draft's references stands in `prompt`. */
function presenceIn(
  prompt: string,
  entries: readonly DraftTeamMemory[],
): Map<DraftTeamMemory, Presence> {
  const presence = new Map<DraftTeamMemory, Presence>();
  if (entries.length === 0) return presence;
  const { unresolved } = removeTeamMemoryBlocks(
    prompt,
    entries.map((entry) => entry.block),
  );
  for (const entry of entries)
    presence.set(
      entry,
      unresolved.includes(entry.block)
        ? "unresolved"
        : prompt.includes(header(entry.block))
          ? "tracked"
          : "gone",
    );
  return presence;
}

export const useDraftTeamMemoryStore = create<DraftTeamMemoryState>()(
  persist((): DraftTeamMemoryState => ({ entries: [], problems: {} }), {
    name: "tritonai:draft-team-memory:v1",
    version: 1,
    storage: createJSONStorage(() =>
      typeof window === "undefined" ? createMemoryStorage() : window.localStorage,
    ),
    partialize: (state) => ({ entries: state.entries }),
  }),
);

const draftKey = (thread: ComposerThreadTarget) => composerTargetKey(thread);
const draftPrompt = (thread: ComposerThreadTarget) =>
  useComposerDraftStore.getState().getComposerDraft(thread)?.prompt ?? "";
/** Prompts queued on this draft's thread; a local draft queues under its session's thread. */
const queuedPrompts = (thread: ComposerThreadTarget) => {
  const session =
    typeof thread === "string" ? useComposerDraftStore.getState().getDraftSession(thread) : null;
  const key = session
    ? scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId))
    : draftKey(thread);
  return (useQueuedMessageStore.getState().queuesByThreadKey[key] ?? []).map(
    (message) => message.prompt,
  );
};
// Drafts whose text a send has taken out; their references stay until the send finishes.
const sending = new Map<string, number>();
// The campus account last seen per environment, so team memory that returns to a draft after a
// switch (a failed send, a stopped queue) is removed too.
const accounts = new Map<string, string | null>();

const groupByDraft = (entries: readonly DraftTeamMemory[]) => {
  const groups = new Map<string, DraftTeamMemory[]>();
  for (const entry of entries) {
    const key = draftKey(entry.thread);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
};

/**
 * References whose text is still somewhere it can be sent from: a draft, a queued message, or a
 * send under way. The rest were sent or deleted and are forgotten.
 */
function liveEntries(entries: readonly DraftTeamMemory[]): DraftTeamMemory[] {
  const live: DraftTeamMemory[] = [];
  for (const [key, group] of groupByDraft(entries)) {
    if (sending.has(key)) {
      live.push(...group);
      continue;
    }
    const presence = presenceIn(draftPrompt(group[0]!.thread), group);
    let queued: string[] | null = null;
    for (const entry of group) {
      if (presence.get(entry) !== "gone") {
        live.push(entry);
        continue;
      }
      queued ??= queuedPrompts(entry.thread);
      if (queued.some((prompt) => presenceIn(prompt, [entry]).get(entry) !== "gone"))
        live.push(entry);
    }
  }
  return live;
}

/** References whose text is in this draft, including edited text that can't be separated. */
export function draftTeamMemoryInPrompt(
  thread: ComposerThreadTarget,
  prompt: string,
): DraftTeamMemory[] {
  const key = draftKey(thread);
  const entries = useDraftTeamMemoryStore
    .getState()
    .entries.filter((entry) => draftKey(entry.thread) === key);
  const presence = presenceIn(prompt, entries);
  return entries.filter((entry) => presence.get(entry) !== "gone");
}

/**
 * Records a note before `insertText` puts it in the draft, so a note is never inserted untracked.
 * An earlier reference to the same note in this draft is replaced. Refused with "full" when
 * {@link MAX_DRAFT_TEAM_MEMORY} references are still live.
 */
export function addDraftTeamMemory(
  entry: DraftTeamMemory,
  insertText: () => boolean,
): "added" | "full" | "not-inserted" {
  const key = draftKey(entry.thread);
  const live = liveEntries(useDraftTeamMemoryStore.getState().entries).filter(
    (existing) =>
      existing.id !== entry.id &&
      !(draftKey(existing.thread) === key && header(existing.block) === header(entry.block)),
  );
  if (live.length >= MAX_DRAFT_TEAM_MEMORY) {
    useDraftTeamMemoryStore.setState({ entries: live });
    return "full";
  }
  if (!insertText()) return "not-inserted";
  useDraftTeamMemoryStore.setState({ entries: [...live, entry] });
  return "added";
}

export function setDraftTeamMemoryProblem(
  thread: ComposerThreadTarget,
  problem: string | null,
): void {
  const key = draftKey(thread);
  useDraftTeamMemoryStore.setState((state) => {
    if ((state.problems[key] ?? null) === problem) return state;
    const { [key]: _removed, ...rest } = state.problems;
    return { problems: problem === null ? rest : { ...rest, [key]: problem } };
  });
}

/**
 * Strips the matching entries' text from their drafts and forgets them. An entry stays tracked
 * when its draft is mid-send, its text is in a queued message, or its edited text can't be
 * separated from the user's.
 */
function removeEntries(matches: (entry: DraftTeamMemory) => boolean): {
  removed: number;
  unresolved: number;
} {
  const { entries, problems } = useDraftTeamMemoryStore.getState();
  const targeted = entries.filter(matches);
  if (targeted.length === 0) return { removed: 0, unresolved: 0 };
  const drafts = useComposerDraftStore.getState();
  const kept = new Set<DraftTeamMemory>();
  const nextProblems = { ...problems };
  let removed = 0;
  let unresolved = 0;
  for (const [key, group] of groupByDraft(targeted)) {
    if (sending.has(key)) {
      for (const entry of group) kept.add(entry);
      continue;
    }
    const thread = group[0]!.thread;
    const prompt = drafts.getComposerDraft(thread)?.prompt ?? "";
    const result = removeTeamMemoryBlocks(
      prompt,
      group.map((entry) => entry.block),
    );
    if (result.prompt !== prompt) {
      drafts.setPrompt(thread, result.prompt);
      removed++;
      delete nextProblems[key];
    }
    if (result.unresolved.length > 0) unresolved++;
    for (const entry of group) if (result.unresolved.includes(entry.block)) kept.add(entry);
  }
  // Queued text can't be edited here; keeping its reference tracks it if it returns to a draft.
  const live = new Set(liveEntries(targeted.filter((entry) => !kept.has(entry))));
  useDraftTeamMemoryStore.setState({
    entries: entries.filter((entry) => !matches(entry) || kept.has(entry) || live.has(entry)),
    problems: nextProblems,
  });
  return { removed, unresolved };
}

/** Removes every team memory inserted into this thread's draft that can be separated from it. */
export function removeDraftTeamMemory(thread: ComposerThreadTarget): void {
  const key = draftKey(thread);
  removeEntries((entry) => draftKey(entry.thread) === key);
}

/**
 * Removes team memory added under an account other than the one now on its environment, then
 * forgets references whose text was sent or deleted.
 */
export function settleDraftTeamMemory(): void {
  removeEntries(
    (entry) =>
      accounts.has(entry.environmentId) && accounts.get(entry.environmentId) !== entry.identity,
  );
  const { entries } = useDraftTeamMemoryStore.getState();
  const live = liveEntries(entries);
  if (live.length !== entries.length) useDraftTeamMemoryStore.setState({ entries: live });
}

/**
 * Holds this draft's references while a send has its text, and settles them when it finishes:
 * kept if the text came back to the draft or went to the queue, forgotten once it was sent.
 */
export function beginDraftTeamMemorySend(thread: ComposerThreadTarget): () => void {
  const key = draftKey(thread);
  sending.set(key, (sending.get(key) ?? 0) + 1);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const count = (sending.get(key) ?? 1) - 1;
    if (count > 0) sending.set(key, count);
    else sending.delete(key);
    settleDraftTeamMemory();
  };
}

/** Tracks references again for text a failed send restored after its own send had finished. */
export function restoreDraftTeamMemory(restored: readonly DraftTeamMemory[]): void {
  useDraftTeamMemoryStore.setState((state) => {
    const ids = new Set(state.entries.map((entry) => entry.id));
    const missing = restored.filter((entry) => !ids.has(entry.id));
    return missing.length === 0 ? state : { entries: [...state.entries, ...missing] };
  });
  settleDraftTeamMemory();
}

/**
 * Called whenever an environment's campus account is known. Team memory added under any other
 * account, or while now signed out, is removed from unsent drafts on that environment. Edited
 * text that can't be separated stays tracked and marked, and is counted as `unresolved`.
 */
export function reconcileDraftTeamMemoryAccount(
  environmentId: string,
  identity: string | null,
): { removed: number; unresolved: number } {
  accounts.set(environmentId, identity);
  return removeEntries(
    (entry) => entry.environmentId === environmentId && entry.identity !== identity,
  );
}

/**
 * Teams whose memory or skills are in this draft now, which of them can't be separated, what
 * kind of team text it is, and why its last send was refused.
 */
export function useDraftTeamMemorySummary(thread: ComposerThreadTarget | null): {
  teams: string;
  unresolvedTeams: string;
  /** "Team memory", "Team skill(s)", or both, for the draft's notice. */
  label: string;
  problem: string | null;
} {
  const key = thread ? draftKey(thread) : null;
  const entries = useDraftTeamMemoryStore(
    useShallow((state) =>
      key === null ? NO_ENTRIES : state.entries.filter((entry) => draftKey(entry.thread) === key),
    ),
  );
  const problem = useDraftTeamMemoryStore((state) =>
    key === null ? null : (state.problems[key] ?? null),
  );
  // Joined strings keep typing elsewhere in the draft from rerendering the caller.
  const summary = useComposerDraftStore((store) => {
    if (thread === null || entries.length === 0) return "\u0000\u0000";
    const presence = presenceIn(store.getComposerDraft(thread)?.prompt ?? "", entries);
    const present = entries.filter((entry) => presence.get(entry) !== "gone");
    const teams = (list: readonly DraftTeamMemory[]) =>
      [...new Set(list.map((entry) => entry.teamName))].join(", ");
    const kinds = new Set(present.map(draftTeamContextKind));
    const label =
      kinds.size > 1
        ? "Team memory and skills"
        : kinds.has("skill")
          ? present.length > 1
            ? "Team skills"
            : "Team skill"
          : "Team memory";
    const unresolved = present.filter((entry) => presence.get(entry) === "unresolved");
    return `${teams(present)}\u0000${teams(unresolved)}\u0000${label}`;
  });
  const [teams = "", unresolvedTeams = "", label = "Team memory"] = summary.split("\u0000");
  return { teams, unresolvedTeams, label, problem };
}
