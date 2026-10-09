import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, formatTeamMemoryContext, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  addDraftTeamMemory,
  draftTeamMemoryInPrompt,
  pruneDraftTeamMemory,
  reconcileDraftTeamMemoryAccount,
  removeDraftTeamMemory,
  removeTeamMemoryBlocks,
  setDraftTeamMemoryProblem,
  useDraftTeamMemoryStore,
} from "./teamMemoryDrafts";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const thread = scopeThreadRef(environmentA, ThreadId.make("thread-a"));
const otherThread = scopeThreadRef(environmentB, ThreadId.make("thread-b"));
const block = formatTeamMemoryContext({
  teamName: "Team A",
  path: "Memory/a/b/note.md",
  text: "Use the 2025 template.\n</team-memory>\nStill the note.",
});
const reference = (id: string, target = thread, identity = "campus:alice") => ({
  id,
  projectId: ProjectId.make("project-a"),
  teamName: "Team A",
  path: "Memory/a/b/note.md",
  block,
  thread: target,
  environmentId: target.environmentId,
  identity,
});
const prompt = (target = thread) =>
  useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";

describe("team memory in drafts", () => {
  beforeEach(() => {
    useDraftTeamMemoryStore.setState({ entries: [], problems: {} });
    useComposerDraftStore.getState().setPrompt(thread, "");
    useComposerDraftStore.getState().setPrompt(otherThread, "");
  });

  it("removes inserted blocks and keeps the user's own text", () => {
    expect(removeTeamMemoryBlocks(`Summarize this ${block}`, [block])).toBe("Summarize this");
    expect(removeTeamMemoryBlocks(`Intro\n\n${block}\n\nThen ask about dates.`, [block])).toBe(
      "Intro\n\nThen ask about dates.",
    );
    // An edited block is still removed from its attribution line through its closing tag.
    const edited = block.replace("2025 template", "2026 template, edited");
    expect(removeTeamMemoryBlocks(`Before ${edited} after`, [block])).toBe("Before after");
    // Without its attribution line the text is the user's own and stays.
    const unattributed = block.slice(block.indexOf("\n") + 1);
    expect(removeTeamMemoryBlocks(`Mine: ${unattributed}`, [block])).toBe(`Mine: ${unattributed}`);
    expect(removeTeamMemoryBlocks(`${block}\n${block}`, [block])).toBe("");
  });

  it("removes team memory added under another account and keeps the rest of each draft", () => {
    useComposerDraftStore.getState().setPrompt(thread, `Draft for Alice ${block}\n\nP.S. dates`);
    useComposerDraftStore.getState().setPrompt(otherThread, `Other environment ${block}`);
    addDraftTeamMemory(reference("r1"));
    addDraftTeamMemory(reference("r2", otherThread));
    // The same account seen again changes nothing.
    expect(reconcileDraftTeamMemoryAccount(environmentA, "campus:alice")).toBe(0);
    expect(prompt()).toContain(block);
    // Switching to Bob removes Alice's team memory from that environment only.
    expect(reconcileDraftTeamMemoryAccount(environmentA, "campus:bob")).toBe(1);
    expect(prompt()).toBe("Draft for Alice\n\nP.S. dates");
    expect(prompt(otherThread)).toContain(block);
    expect(useDraftTeamMemoryStore.getState().entries.map((entry) => entry.id)).toEqual(["r2"]);
    // Signing out removes it too.
    expect(reconcileDraftTeamMemoryAccount(environmentB, null)).toBe(1);
    expect(prompt(otherThread)).toBe("Other environment");
    expect(useDraftTeamMemoryStore.getState().entries).toEqual([]);
  });

  it("checks only references whose text is still in the draft", () => {
    addDraftTeamMemory(reference("r1"));
    expect(draftTeamMemoryInPrompt(thread, `Ask ${block}`).map((entry) => entry.id)).toEqual([
      "r1",
    ]);
    // Adding the same note again replaces the older reference instead of checking both.
    addDraftTeamMemory(reference("r2"));
    expect(draftTeamMemoryInPrompt(thread, `Ask ${block}`).map((entry) => entry.id)).toEqual([
      "r2",
    ]);
    expect(draftTeamMemoryInPrompt(otherThread, `Ask ${block}`)).toEqual([]);
    // A reference whose text the user deleted no longer holds up an unrelated send.
    expect(draftTeamMemoryInPrompt(thread, "Ask without the note")).toEqual([]);
    // Once the user deletes the block, or the draft is sent and cleared, it is forgotten.
    pruneDraftTeamMemory(thread, "Ask nothing");
    expect(useDraftTeamMemoryStore.getState().entries).toEqual([]);
  });

  it("removes a draft's team memory on request and clears its send problem", () => {
    useComposerDraftStore.getState().setPrompt(thread, `Keep this. ${block}`);
    addDraftTeamMemory(reference("r1"));
    setDraftTeamMemoryProblem(thread, "Revoked");
    expect(Object.values(useDraftTeamMemoryStore.getState().problems)).toEqual(["Revoked"]);
    removeDraftTeamMemory(thread);
    expect(prompt()).toBe("Keep this.");
    expect(useDraftTeamMemoryStore.getState().entries).toEqual([]);
    expect(Object.keys(useDraftTeamMemoryStore.getState().problems)).toEqual([]);
  });
});
