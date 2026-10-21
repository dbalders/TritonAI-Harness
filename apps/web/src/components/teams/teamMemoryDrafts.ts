import {
  type EnvironmentId,
  TEAM_SKILL_PREAMBLE,
  MAX_TEAM_MEMORY_REFERENCES,
  MAX_TEAM_MESSAGE_REFERENCES,
  type TeamContextKind,
  type TeamMemoryReference,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import {
  type ComposerThreadTarget,
  composerTargetKey,
  resolveComposerDraftKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { createMemoryStorage } from "../../lib/storage";

/**
 * Unsent team memory and skills tracked at once. Beyond it a new one is refused; a live one is
 * never dropped.
 */
export const MAX_DRAFT_TEAM_MEMORY = MAX_TEAM_MEMORY_REFERENCES;
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
  /** The user edited protected text; missing wrapper lines no longer prove its removal. */
  readonly edited?: boolean;
  /** A reattachment replaced an entry whose edited text had already lost its boundaries. */
  readonly detached?: boolean;
}

interface DraftTeamMemoryState {
  readonly entries: readonly DraftTeamMemory[];
  /** Server-issued provenance from a queued message, whose edited text has no safe boundaries. */
  readonly inheritedReferences: Readonly<
    Record<
      string,
      { readonly thread: ComposerThreadTarget; readonly references: readonly string[] }
    >
  >;
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
  const normalized = text.replace(/\s+/gu, " ");
  const orphanClosingTag = hasOrphanClosingTag(text);
  return (block) => {
    const note = /(?:note|skill)="([^"]+)"/u.exec(header(block))?.[1];
    return (
      orphanClosingTag ||
      (note !== undefined && text.includes(note)) ||
      noteLines(block).some((line) => normalized.includes(line.replace(/\s+/gu, " ")))
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
      unresolved.includes(entry.block) ||
        (entry.edited &&
          prompt.trim().length > 0 &&
          (entry.detached || !prompt.includes(header(entry.block))))
        ? "unresolved"
        : prompt.includes(header(entry.block))
          ? "tracked"
          : "gone",
    );
  return presence;
}

export const useDraftTeamMemoryStore = create<DraftTeamMemoryState>()(
  persist((): DraftTeamMemoryState => ({ entries: [], inheritedReferences: {}, problems: {} }), {
    name: "tritonai:draft-team-memory:v1",
    version: 1,
    storage: createJSONStorage(() =>
      typeof window === "undefined" ? createMemoryStorage() : window.localStorage,
    ),
    partialize: (state) => ({
      entries: state.entries,
      inheritedReferences: state.inheritedReferences,
    }),
  }),
);

const draftKey = (thread: ComposerThreadTarget) => composerTargetKey(thread);
const draftPrompt = (thread: ComposerThreadTarget) =>
  useComposerDraftStore.getState().getComposerDraft(thread)?.prompt ?? "";
// Drafts whose text a send has taken out; their references stay until the send finishes.
const sending = new Map<string, number>();
// The campus account last seen per environment, so team memory that returns to a draft after a
// switch (a failed send, a stopped queue) is removed too.
const accounts = new Map<string, string | null>();
const accountRevisions = new Map<string, number>();

/** Actual account transitions invalidate a pending check, including switching away and back. */
export function draftTeamMemoryAccountRevision(environmentId: string): number {
  return accountRevisions.get(environmentId) ?? 0;
}

const groupByDraft = (entries: readonly DraftTeamMemory[]) => {
  const groups = new Map<string, DraftTeamMemory[]>();
  for (const entry of entries) {
    const key = draftKey(entry.thread);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
};

/**
 * References whose text is in an unsent draft or a send under way. Once a message is accepted,
 * the server owns its durable team provenance, including while it is queued.
 */
function liveEntries(entries: readonly DraftTeamMemory[]): DraftTeamMemory[] {
  const live: DraftTeamMemory[] = [];
  for (const [key, group] of groupByDraft(entries)) {
    if (sending.has(key)) {
      live.push(...group);
      continue;
    }
    const presence = presenceIn(draftPrompt(group[0]!.thread), group);
    for (const entry of group) {
      if (presence.get(entry) !== "gone") {
        live.push(entry);
        continue;
      }
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

/** Every reference the server must recheck, including a recovered queue edit's provenance. */
export function draftTeamReferenceIds(thread: ComposerThreadTarget, prompt: string): string[] {
  const inherited =
    prompt.trim().length === 0
      ? []
      : (useDraftTeamMemoryStore.getState().inheritedReferences[draftKey(thread)]?.references ??
        []);
  return [
    ...new Set([...inherited, ...draftTeamMemoryInPrompt(thread, prompt).map((entry) => entry.id)]),
  ];
}

export function inheritDraftTeamReferences(
  thread: ComposerThreadTarget,
  references: readonly string[],
): void {
  if (references.length === 0) return;
  const key = draftKey(thread);
  useDraftTeamMemoryStore.setState((state) => ({
    inheritedReferences: {
      ...state.inheritedReferences,
      [key]: {
        thread,
        references: [
          ...new Set([...(state.inheritedReferences[key]?.references ?? []), ...references]),
        ],
      },
    },
  }));
}

/** Moves the protection with a dirty queue edit when the native queue returns it to the composer. */
export function moveDraftTeamMemory(from: ComposerThreadTarget, to: ComposerThreadTarget): void {
  const fromKey = draftKey(from);
  const toKey = draftKey(to);
  if (fromKey === toKey) return;
  useDraftTeamMemoryStore.setState((state) => {
    const { [fromKey]: inherited, ...remaining } = state.inheritedReferences;
    return {
      entries: state.entries.map((entry) =>
        draftKey(entry.thread) === fromKey ? { ...entry, thread: to } : entry,
      ),
      inheritedReferences:
        inherited === undefined
          ? remaining
          : {
              ...remaining,
              [toKey]: {
                thread: to,
                references: [
                  ...new Set([...(remaining[toKey]?.references ?? []), ...inherited.references]),
                ],
              },
            },
    };
  });
}

/** Recovered queue edits cannot separate team text from the user's edits, so clearing is explicit. */
export function clearDraftTeamReferenceText(thread: ComposerThreadTarget): void {
  useComposerDraftStore.getState().setPrompt(thread, "");
  settleDraftTeamMemory();
}

/**
 * Records a note before `insertText` puts it in the draft, so a note is never inserted untracked.
 * An earlier reference to the same note in this draft is replaced. Refused with "full" when
 * {@link MAX_DRAFT_TEAM_MEMORY} manually inserted references are live, or inherited queue context
 * would take this message beyond {@link MAX_TEAM_MESSAGE_REFERENCES}.
 */
export function addDraftTeamMemory(
  entry: DraftTeamMemory,
  insertText: () => boolean,
): "added" | "full" | "not-inserted" {
  const key = draftKey(entry.thread);
  const current = liveEntries(useDraftTeamMemoryStore.getState().entries);
  const replacing = (existing: DraftTeamMemory) =>
    existing.id === entry.id ||
    (draftKey(existing.thread) === key && header(existing.block) === header(entry.block));
  const previous = current.filter(
    (existing) => draftKey(existing.thread) === key && replacing(existing),
  );
  const live = current.filter((existing) => !replacing(existing));
  const nextEntry = previous.some((existing) => existing.edited)
    ? {
        ...entry,
        edited: true,
        detached: previous.some(
          (existing) =>
            existing.detached || !draftPrompt(entry.thread).includes(header(existing.block)),
        ),
      }
    : entry;
  const inheritedIds =
    useDraftTeamMemoryStore.getState().inheritedReferences[key]?.references ?? [];
  const messageIds = new Set([
    ...inheritedIds,
    ...live.filter((existing) => draftKey(existing.thread) === key).map((existing) => existing.id),
    entry.id,
  ]);
  if (live.length >= MAX_DRAFT_TEAM_MEMORY || messageIds.size > MAX_TEAM_MESSAGE_REFERENCES) {
    useDraftTeamMemoryStore.setState({ entries: current });
    return "full";
  }
  if (!insertText()) return "not-inserted";
  useDraftTeamMemoryStore.setState({ entries: [...live, nextEntry] });
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
 * when its draft is mid-send or its edited text can't be separated from the user's.
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
  let unresolvedDrafts = 0;
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
    const unresolved = new Set(result.unresolved);
    for (const entry of group) {
      if (
        entry.edited &&
        result.prompt.trim().length > 0 &&
        (entry.detached || !prompt.includes(header(entry.block)))
      )
        unresolved.add(entry.block);
    }
    if (result.prompt !== prompt) {
      drafts.setPrompt(thread, result.prompt);
      removed++;
      delete nextProblems[key];
    }
    if (unresolved.size > 0) unresolvedDrafts++;
    for (const entry of group) if (unresolved.has(entry.block)) kept.add(entry);
  }
  useDraftTeamMemoryStore.setState({
    entries: entries.filter((entry) => !matches(entry) || kept.has(entry)),
    problems: nextProblems,
  });
  return { removed, unresolved: unresolvedDrafts };
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
  const { entries, inheritedReferences } = useDraftTeamMemoryStore.getState();
  const live = liveEntries(entries);
  const inherited = Object.fromEntries(
    Object.entries(inheritedReferences).filter(
      ([key, entry]) => sending.has(key) || draftPrompt(entry.thread).trim().length > 0,
    ),
  );
  if (
    live.length !== entries.length ||
    Object.keys(inherited).length !== Object.keys(inheritedReferences).length
  )
    useDraftTeamMemoryStore.setState({ entries: live, inheritedReferences: inherited });
}

/**
 * Holds this draft's references while a send has its text, and settles them when it finishes:
 * kept if the text came back to the draft, forgotten once the server accepted it.
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
  if (!accounts.has(environmentId) || accounts.get(environmentId) !== identity) {
    accountRevisions.set(environmentId, draftTeamMemoryAccountRevision(environmentId) + 1);
  }
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
  inherited: boolean;
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
  const inherited = useDraftTeamMemoryStore((state) =>
    key === null ? false : (state.inheritedReferences[key]?.references.length ?? 0) > 0,
  );
  // Joined strings keep typing elsewhere in the draft from rerendering the caller.
  const summary = useComposerDraftStore((store) => {
    if (thread === null) return "\u0000\u0000";
    const prompt = store.getComposerDraft(thread)?.prompt ?? "";
    const hasInherited = inherited && prompt.trim().length > 0;
    if (entries.length === 0 && !hasInherited) return "\u0000\u0000";
    const presence = presenceIn(prompt, entries);
    const present = entries.filter((entry) => presence.get(entry) !== "gone");
    const teams = (list: readonly DraftTeamMemory[]) =>
      [...new Set(list.map((entry) => entry.teamName))].join(", ");
    const kinds = new Set(present.map(draftTeamContextKind));
    const label = hasInherited
      ? "Team context"
      : kinds.size > 1
        ? "Team memory and skills"
        : kinds.has("skill")
          ? present.length > 1
            ? "Team skills"
            : "Team skill"
          : "Team memory";
    const unresolved = present.filter((entry) => presence.get(entry) === "unresolved");
    return `${teams(present) || (hasInherited ? "a queued message" : "")}\u0000${teams(unresolved)}\u0000${label}`;
  });
  const [teams = "", unresolvedTeams = "", label = "Team memory"] = summary.split("\u0000");
  return { teams, unresolvedTeams, label, problem, inherited };
}

// Track edits at the draft boundary, before losing a wrapper can erase its provenance. Only a
// complete attributed-block removal or clearing the prompt establishes that the text is gone.
useComposerDraftStore.subscribe((next, previous) => {
  const state = useDraftTeamMemoryStore.getState();
  let changed = false;
  const entries = state.entries.flatMap((entry) => {
    const key = draftKey(entry.thread);
    const previousKey = resolveComposerDraftKey(previous, entry.thread);
    const nextKey = resolveComposerDraftKey(next, entry.thread);
    const before = previousKey ? (previous.draftsByThreadKey[previousKey]?.prompt ?? "") : "";
    const after = nextKey ? (next.draftsByThreadKey[nextKey]?.prompt ?? "") : "";
    if (before === after) return [entry];
    if (after.trim().length === 0) {
      if (sending.has(key)) return [entry];
      // Native queue recovery moves the whole prompt atomically; its caller moves provenance next.
      const moved = Object.entries(next.draftsByThreadKey).some(
        ([otherKey, draft]) =>
          otherKey !== nextKey &&
          draft.prompt === before &&
          previous.draftsByThreadKey[otherKey]?.prompt !== draft.prompt,
      );
      if (moved) return [entry];
      changed = true;
      return [];
    }
    const hadWrapper = before.includes(header(entry.block));
    if (hadWrapper && !entry.detached) {
      const removed = removeTeamMemoryBlocks(before, [entry.block]);
      if (
        removed.unresolved.length === 0 &&
        after.replace(/\s+/gu, " ").trim() === removed.prompt.replace(/\s+/gu, " ").trim()
      ) {
        changed = true;
        return [];
      }
    }
    if (
      !entry.edited &&
      !after.includes(entry.block) &&
      (hadWrapper || leftoverOf(before)(entry.block))
    ) {
      changed = true;
      return [{ ...entry, edited: true }];
    }
    return [entry];
  });
  if (changed) useDraftTeamMemoryStore.setState({ entries });
});
