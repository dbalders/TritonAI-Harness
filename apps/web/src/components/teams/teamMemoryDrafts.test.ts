import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  formatTeamMemoryContext,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { useQueuedMessageStore } from "../../queuedMessageStore";
import {
  addDraftTeamMemory,
  beginDraftTeamMemorySend,
  draftTeamMemoryInPrompt,
  MAX_DRAFT_TEAM_MEMORY,
  reconcileDraftTeamMemoryAccount,
  removeDraftTeamMemory,
  removeTeamMemoryBlocks,
  restoreDraftTeamMemory,
  setDraftTeamMemoryProblem,
  settleDraftTeamMemory,
  useDraftTeamMemoryStore,
} from "./teamMemoryDrafts";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const threadAt = (id: string, environment = environmentA) =>
  scopeThreadRef(environment, ThreadId.make(id));
const thread = threadAt("thread-a");
const otherThread = threadAt("thread-b", environmentB);
const note = (path: string, text: string) =>
  formatTeamMemoryContext({ teamName: "Team A", path, text });
const block = note(
  "Memory/a/b/note.md",
  "Use the 2025 template for every grant report.\n</team-memory>\nStill the note.",
);
const secondBlock = note("Memory/a/b/other.md", "Budget lines go in the appendix this year.");
const reference = (
  id: string,
  target: ComposerThreadTarget = thread,
  identity = "campus:alice",
  text = block,
) => ({
  id,
  projectId: ProjectId.make("project-a"),
  teamName: "Team A",
  path: /note="([^"]+)"/u.exec(text)![1]!,
  block: text,
  thread: target,
  environmentId: typeof target === "string" ? environmentA : target.environmentId,
  identity,
});
const prompt = (target: ComposerThreadTarget = thread) =>
  useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
const setPrompt = (target: ComposerThreadTarget, text: string) =>
  useComposerDraftStore.getState().setPrompt(target, text);
/** Adds a note the way the dialog does: tracked first, then appended to the draft. */
const insert = (entry: ReturnType<typeof reference>) => {
  let inserted = false;
  const result = addDraftTeamMemory(entry, () => {
    inserted = true;
    setPrompt(entry.thread, `${prompt(entry.thread)}\n\n${entry.block}`.trim());
    return true;
  });
  return { result, inserted };
};
/** A send from the composer: the draft is cleared, then restored, queued, or gone. */
const send = (target: ComposerThreadTarget, outcome: "sent" | "failed" | "queued") => {
  const finish = beginDraftTeamMemorySend(target);
  const text = prompt(target);
  setPrompt(target, "");
  if (outcome === "failed") setPrompt(target, text);
  if (outcome === "queued")
    useQueuedMessageStore.getState().enqueue("queue-key", {
      prompt: text,
      images: [],
      files: [],
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
      sendSettings: {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        promptEffort: null,
      },
      queuedAfterToolActivityId: null,
      createdAt: "2026-10-09T00:00:00.000Z",
    });
  finish();
};
const ids = () => useDraftTeamMemoryStore.getState().entries.map((entry) => entry.id);

describe("team memory in drafts", () => {
  beforeEach(() => {
    useDraftTeamMemoryStore.setState({ entries: [], problems: {} });
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
    setPrompt(thread, "");
    setPrompt(otherThread, "");
    reconcileDraftTeamMemoryAccount(environmentA, "campus:alice");
    reconcileDraftTeamMemoryAccount(environmentB, "campus:alice");
  });

  it("removes inserted blocks and keeps the user's own text", () => {
    const removed = (text: string, blocks = [block]) => removeTeamMemoryBlocks(text, blocks);
    expect(removed(`Summarize this ${block}`)).toEqual({
      prompt: "Summarize this",
      unresolved: [],
    });
    expect(removed(`Intro\n\n${block}\n\nThen ask about dates.`).prompt).toBe(
      "Intro\n\nThen ask about dates.",
    );
    // An edited body is still removed from its attribution line through its closing tag.
    const edited = block.replace("2025 template", "2026 template, edited");
    expect(removed(`Before ${edited} after`)).toEqual({ prompt: "Before after", unresolved: [] });
    expect(removed(`${block}\n${block}`).prompt).toBe("");
    // Two blocks with the user's text between them each go, and the text between stays.
    expect(removed(`${block}\n\nMine\n\n${secondBlock}`, [block, secondBlock]).prompt).toBe("Mine");
  });

  it("leaves edited team memory whose end can't be found in place and reports it", () => {
    const withoutClosing = block.slice(0, block.lastIndexOf("\n"));
    // The closing line was deleted: the end of the note is unknown, so nothing is removed.
    const unclosed = `my question\n\n${withoutClosing}\nplease summarize`;
    expect(removeTeamMemoryBlocks(unclosed, [block])).toEqual({
      prompt: unclosed,
      unresolved: [block],
    });
    // A later block's closing tag never ends an earlier one, so the user's text between survives.
    const adjacent = `${withoutClosing}\nMY OWN IMPORTANT TEXT\n\n${secondBlock}\ntrailing user text`;
    expect(removeTeamMemoryBlocks(adjacent, [block, secondBlock])).toEqual({
      prompt: `${withoutClosing}\nMY OWN IMPORTANT TEXT\n\ntrailing user text`,
      unresolved: [block],
    });
    // A mangled attribution line or a deleted one still leaves the note's text recognizable.
    const mangled = block.replace('team="Team A"', 'team="Team Z"');
    expect(removeTeamMemoryBlocks(`Mine ${mangled}`, [block]).unresolved).toEqual([block]);
    const headless = block.slice(block.indexOf("\n") + 1);
    expect(removeTeamMemoryBlocks(`Mine: ${headless}`, [block])).toEqual({
      prompt: `Mine: ${headless}`,
      unresolved: [block],
    });
    // A note added twice, one copy intact and one cut short: the intact copy goes.
    expect(removeTeamMemoryBlocks(`${block}\n\nAsk\n\n${withoutClosing}`, [block])).toEqual({
      prompt: `Ask\n\n${withoutClosing}`,
      unresolved: [block],
    });
    // Once the user deletes every trace of the note, nothing is left to track.
    expect(removeTeamMemoryBlocks("Ask about dates", [block]).unresolved).toEqual([]);
  });

  it("keeps edited team memory tracked and marked through sign-out", () => {
    const withoutClosing = block.slice(0, block.lastIndexOf("\n"));
    insert(reference("r1"));
    insert(reference("r2", thread, "campus:alice", secondBlock));
    setPrompt(thread, `Ask\n\n${withoutClosing}\nMY OWN IMPORTANT TEXT\n\n${secondBlock}`);
    expect(draftTeamMemoryInPrompt(thread, prompt()).map((entry) => entry.id)).toEqual([
      "r1",
      "r2",
    ]);
    expect(reconcileDraftTeamMemoryAccount(environmentA, null)).toEqual({
      removed: 1,
      unresolved: 1,
    });
    // The intact note is gone; the edited one and the user's text stay, still tracked, so the
    // next send is checked (and refused for a signed-out account) instead of going out as text.
    expect(prompt()).toBe(`Ask\n\n${withoutClosing}\nMY OWN IMPORTANT TEXT`);
    expect(ids()).toEqual(["r1"]);
    expect(draftTeamMemoryInPrompt(thread, prompt()).map((entry) => entry.id)).toEqual(["r1"]);
    // Deleting the rest of the note ends tracking.
    setPrompt(thread, "Ask\n\nMY OWN IMPORTANT TEXT");
    settleDraftTeamMemory();
    expect(ids()).toEqual([]);
  });

  it("removes team memory added under another account and keeps the rest of each draft", () => {
    setPrompt(thread, "Draft for Alice");
    insert(reference("r1"));
    setPrompt(thread, `${prompt()}\n\nP.S. dates`);
    setPrompt(otherThread, "Other environment");
    insert(reference("r2", otherThread));
    // The same account seen again changes nothing.
    expect(reconcileDraftTeamMemoryAccount(environmentA, "campus:alice").removed).toBe(0);
    expect(prompt()).toContain(block);
    // Switching to Bob removes Alice's team memory from that environment only.
    expect(reconcileDraftTeamMemoryAccount(environmentA, "campus:bob")).toEqual({
      removed: 1,
      unresolved: 0,
    });
    expect(prompt()).toBe("Draft for Alice\n\nP.S. dates");
    expect(prompt(otherThread)).toContain(block);
    expect(ids()).toEqual(["r2"]);
    // Signing out removes it too.
    expect(reconcileDraftTeamMemoryAccount(environmentB, null).removed).toBe(1);
    expect(prompt(otherThread)).toBe("Other environment");
    expect(ids()).toEqual([]);
  });

  it("checks only references whose text is still in the draft", () => {
    insert(reference("r1"));
    expect(draftTeamMemoryInPrompt(thread, `Ask ${block}`).map((entry) => entry.id)).toEqual([
      "r1",
    ]);
    // Adding the same note again replaces the older reference instead of checking both.
    insert(reference("r2"));
    expect(draftTeamMemoryInPrompt(thread, `Ask ${block}`).map((entry) => entry.id)).toEqual([
      "r2",
    ]);
    expect(draftTeamMemoryInPrompt(otherThread, `Ask ${block}`)).toEqual([]);
    // A reference whose text the user deleted no longer holds up an unrelated send.
    expect(draftTeamMemoryInPrompt(thread, "Ask without the note")).toEqual([]);
  });

  it("keeps tracking a long-lived draft while other threads add and send team memory", () => {
    setPrompt(thread, "Still writing this one");
    insert(reference("t0"));
    for (let index = 1; index <= MAX_DRAFT_TEAM_MEMORY; index++) {
      const target = threadAt(`thread-${index}`);
      expect(insert(reference(`r${index}`, target)).result).toBe("added");
      send(target, "sent");
    }
    // The unsent note is still checked at send; sent ones were forgotten as each send finished.
    expect(draftTeamMemoryInPrompt(thread, prompt()).map((entry) => entry.id)).toEqual(["t0"]);
    expect(ids()).toEqual(["t0"]);
    expect(reconcileDraftTeamMemoryAccount(environmentA, null).removed).toBe(1);
    expect(prompt()).toBe("Still writing this one");
  });

  it("refuses a new note before inserting it when every tracked note is still unsent", () => {
    const targets = Array.from({ length: MAX_DRAFT_TEAM_MEMORY }, (_, index) =>
      threadAt(`thread-${index}`),
    );
    for (const [index, target] of targets.entries()) insert(reference(`r${index}`, target));
    const extra = insert(reference("extra"));
    expect(extra).toEqual({ result: "full", inserted: false });
    expect(prompt()).toBe("");
    expect(ids()).toHaveLength(MAX_DRAFT_TEAM_MEMORY);
    expect(ids()).not.toContain("extra");
    // Deleting a note by hand frees its place; the rest stay tracked.
    setPrompt(targets[0]!, "");
    expect(insert(reference("extra"))).toEqual({ result: "added", inserted: true });
    expect(ids()).toHaveLength(MAX_DRAFT_TEAM_MEMORY);
    expect(ids()).not.toContain("r0");
  });

  it("keeps references a failed or queued send still needs", () => {
    insert(reference("r1"));
    send(thread, "failed");
    expect(prompt()).toBe(block);
    expect(ids()).toEqual(["r1"]);
    // A queued message holds its text outside the draft; its reference stays for a later restore.
    send(thread, "queued");
    expect(prompt()).toBe("");
    for (let index = 1; index < MAX_DRAFT_TEAM_MEMORY; index++)
      insert(reference(`r${index + 1}`, threadAt(`thread-${index}`)));
    expect(insert(reference("extra", threadAt("thread-extra"))).result).toBe("full");
    expect(ids()).toContain("r1");
    // Stop puts the queued text back in the draft, still tracked.
    const [restored] = useQueuedMessageStore.getState().drain("queue-key");
    setPrompt(thread, restored!.prompt);
    settleDraftTeamMemory();
    expect(draftTeamMemoryInPrompt(thread, prompt()).map((entry) => entry.id)).toEqual(["r1"]);
  });

  it("removes team memory that returns to a draft after the account changed", () => {
    setPrompt(thread, "Keep this.");
    insert(reference("r1"));
    // Signing out while the send is under way can't reach the text; the reference waits for it.
    const finish = beginDraftTeamMemorySend(thread);
    const text = prompt();
    setPrompt(thread, "");
    expect(reconcileDraftTeamMemoryAccount(environmentA, null).removed).toBe(0);
    expect(ids()).toEqual(["r1"]);
    setPrompt(thread, text);
    finish();
    expect(prompt()).toBe("Keep this.");
    expect(ids()).toEqual([]);
    // A failed multi-model send restored later from its toast is tracked, then removed the same way.
    setPrompt(thread, text);
    restoreDraftTeamMemory([reference("r1")]);
    expect(prompt()).toBe("Keep this.");
    expect(ids()).toEqual([]);
  });

  it("removes a draft's team memory on request and clears its send problem", () => {
    setPrompt(thread, "Keep this.");
    insert(reference("r1"));
    setDraftTeamMemoryProblem(thread, "Revoked");
    expect(Object.values(useDraftTeamMemoryStore.getState().problems)).toEqual(["Revoked"]);
    removeDraftTeamMemory(thread);
    expect(prompt()).toBe("Keep this.");
    expect(ids()).toEqual([]);
    expect(Object.keys(useDraftTeamMemoryStore.getState().problems)).toEqual([]);
  });
});
