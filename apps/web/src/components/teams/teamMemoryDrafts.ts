import type { EnvironmentId, TeamMemoryReference } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import {
  type ComposerThreadTarget,
  composerTargetKey,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { createMemoryStorage } from "../../lib/storage";

const MAX_ENTRIES = 50;
const NO_ENTRIES: readonly DraftTeamMemory[] = [];
const CLOSING_TAG = "</team-memory>";

/**
 * Team memory inserted into one thread's unsent draft. The text lives in the draft like any
 * other text; this record is what lets the server recheck the reference before sending and lets
 * the client remove the text when the campus account changes.
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

/** Whether a draft still carries the block's attribution line. */
export const draftHoldsTeamMemory = (prompt: string, block: string) =>
  prompt.includes(header(block));

/**
 * Removes inserted team-memory blocks and keeps the rest of the draft. An edited block is removed
 * from its attribution line through its closing tag; a block whose attribution line the user
 * deleted is no longer recognizable and stays as the user's own text.
 */
export function removeTeamMemoryBlocks(prompt: string, blocks: readonly string[]): string {
  let next = prompt;
  for (const block of blocks) {
    const opening = header(block);
    for (;;) {
      let start = next.indexOf(block);
      let end = start + block.length;
      if (start < 0) {
        start = next.indexOf(opening);
        if (start < 0) break;
        const close = next.indexOf(CLOSING_TAG, start + opening.length);
        end = close < 0 ? start + opening.length : close + CLOSING_TAG.length;
      }
      const before = next.slice(0, start);
      const after = next.slice(end);
      const kept = [before.trimEnd(), after.trimStart()];
      const gap = /\n/u.test(
        before.slice(kept[0]!.length) + after.slice(0, after.length - kept[1]!.length),
      )
        ? "\n\n"
        : " ";
      next = kept[0] && kept[1] ? `${kept[0]}${gap}${kept[1]}` : kept[0] || kept[1]!;
    }
  }
  return next;
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

/** References whose attribution line is still in this draft's text. */
export function draftTeamMemoryInPrompt(
  thread: ComposerThreadTarget,
  prompt: string,
): DraftTeamMemory[] {
  const key = draftKey(thread);
  return useDraftTeamMemoryStore
    .getState()
    .entries.filter(
      (entry) => draftKey(entry.thread) === key && draftHoldsTeamMemory(prompt, entry.block),
    );
}

/** Records an inserted block; an earlier reference to the same block in this draft is replaced. */
export function addDraftTeamMemory(entry: DraftTeamMemory): void {
  const key = draftKey(entry.thread);
  useDraftTeamMemoryStore.setState((state) => ({
    entries: [
      ...state.entries.filter(
        (existing) =>
          existing.id !== entry.id &&
          !(draftKey(existing.thread) === key && header(existing.block) === header(entry.block)),
      ),
      entry,
    ].slice(-MAX_ENTRIES),
  }));
}

/** Forgets references whose text is no longer in this draft, such as after it was sent. */
export function pruneDraftTeamMemory(thread: ComposerThreadTarget, prompt: string): void {
  const key = draftKey(thread);
  const { entries } = useDraftTeamMemoryStore.getState();
  const kept = entries.filter(
    (entry) => draftKey(entry.thread) !== key || draftHoldsTeamMemory(prompt, entry.block),
  );
  if (kept.length !== entries.length) useDraftTeamMemoryStore.setState({ entries: kept });
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

/** Strips the matching entries' text from their drafts and forgets them; returns drafts changed. */
function removeEntries(matches: (entry: DraftTeamMemory) => boolean): number {
  const { entries, problems } = useDraftTeamMemoryStore.getState();
  const removed = entries.filter(matches);
  if (removed.length === 0) return 0;
  const drafts = useComposerDraftStore.getState();
  const byDraft = new Map<string, DraftTeamMemory[]>();
  for (const entry of removed) {
    const key = draftKey(entry.thread);
    byDraft.set(key, [...(byDraft.get(key) ?? []), entry]);
  }
  let changed = 0;
  const nextProblems = { ...problems };
  for (const [key, group] of byDraft) {
    delete nextProblems[key];
    const thread = group[0]!.thread;
    const prompt = drafts.getComposerDraft(thread)?.prompt ?? "";
    const next = removeTeamMemoryBlocks(
      prompt,
      group.map((entry) => entry.block),
    );
    if (next === prompt) continue;
    drafts.setPrompt(thread, next);
    changed++;
  }
  useDraftTeamMemoryStore.setState({
    entries: entries.filter((entry) => !matches(entry)),
    problems: nextProblems,
  });
  return changed;
}

/** Removes every team memory inserted into this thread's draft. */
export function removeDraftTeamMemory(thread: ComposerThreadTarget): void {
  const key = draftKey(thread);
  removeEntries((entry) => draftKey(entry.thread) === key);
}

/**
 * Called whenever an environment's campus account is known. Team memory added under any other
 * account, or while now signed out, is removed from unsent drafts on that environment.
 */
export function reconcileDraftTeamMemoryAccount(
  environmentId: string,
  identity: string | null,
): number {
  return removeEntries(
    (entry) => entry.environmentId === environmentId && entry.identity !== identity,
  );
}

/** Teams whose memory is in this draft now, and why its last send was refused, for the composer. */
export function useDraftTeamMemorySummary(thread: ComposerThreadTarget | null): {
  teams: string;
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
  // A joined string keeps typing elsewhere in the draft from rerendering the caller.
  const teams = useComposerDraftStore((store) => {
    if (thread === null || entries.length === 0) return "";
    const prompt = store.getComposerDraft(thread)?.prompt ?? "";
    return [
      ...new Set(
        entries
          .filter((entry) => draftHoldsTeamMemory(prompt, entry.block))
          .map((entry) => entry.teamName),
      ),
    ].join(", ");
  });
  return { teams, problem };
}
