import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  formatTeamContext,
  formatTeamMemoryContext,
  ProjectId,
  ThreadId,
  TeamProjectCommand,
  MAX_TEAM_MESSAGE_REFERENCES,
  MAX_TEAM_PROJECT_SKILLS,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  type ComposerThreadTarget,
  DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  addDraftTeamMemory,
  beginDraftTeamMemorySend,
  draftTeamMemoryInPrompt,
  draftTeamReferenceIds,
  inheritDraftTeamReferences,
  moveDraftTeamMemory,
  clearDraftTeamReferenceText,
  MAX_DRAFT_TEAM_MEMORY,
  reconcileDraftTeamMemoryAccount,
  removeDraftTeamMemory,
  removeTeamMemoryBlocks,
  restoreDraftTeamMemory,
  setDraftTeamMemoryProblem,
  settleDraftTeamMemory,
  useDraftTeamMemoryStore,
} from "./teamMemoryDrafts";

const isTeamProjectCommand = Schema.is(TeamProjectCommand);
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
  finish();
};
const ids = () => useDraftTeamMemoryStore.getState().entries.map((entry) => entry.id);
const skill = (path: string, text: string) =>
  formatTeamContext({ kind: "skill", teamName: "Team A", path, text });
const skillBlock = skill(
  "Skills/a/b/skill.md",
  "Run the grant checklist before filing.\n</team-skill>\nThen file it with the office.",
);
const secondSkill = skill("Skills/a/b/other.md", "Check every budget line against the award.");
const skillReference = (id: string, text = skillBlock) => ({
  ...reference(id),
  kind: "skill" as const,
  path: /skill="([^"]+)"/u.exec(text)![1]!,
  block: text,
});

describe("team memory in drafts", () => {
  beforeEach(() => {
    useDraftTeamMemoryStore.setState({ entries: [], inheritedReferences: {}, problems: {} });
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
    // After a block's boundaries were edited away, later rewriting cannot prove removal.
    setPrompt(thread, "Ask\n\nMY OWN IMPORTANT TEXT");
    settleDraftTeamMemory();
    expect(ids()).toEqual(["r1"]);
    clearDraftTeamReferenceText(thread);
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

  it("can verify every reference in a full draft and refuses the next insertion", () => {
    for (let index = 0; index < MAX_DRAFT_TEAM_MEMORY; index++) {
      expect(
        insert(
          reference(
            `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
            thread,
            "campus:alice",
            note(`Memory/a/b/${index}.md`, `Note ${index} has a separate policy.`),
          ),
        ).result,
      ).toBe("added");
    }
    const references = draftTeamMemoryInPrompt(thread, prompt()).map((entry) => entry.id);
    expect(references).toHaveLength(MAX_DRAFT_TEAM_MEMORY);
    expect(isTeamProjectCommand({ action: "memory-verify", references })).toBe(true);
    expect(insert(reference("extra", thread, "campus:alice", secondBlock))).toEqual({
      result: "full",
      inserted: false,
    });
    expect(
      isTeamProjectCommand({
        action: "memory-verify",
        references: [
          ...references,
          ...Array.from(
            { length: MAX_TEAM_MESSAGE_REFERENCES - MAX_DRAFT_TEAM_MEMORY + 1 },
            (_, index) => `ffffffff-ffff-ffff-ffff-${String(index).padStart(12, "0")}`,
          ),
        ],
      }),
    ).toBe(false);
  });

  it.each(["memory", "skill"] as const)(
    "retains %s provenance after wrappers are removed and text is reflowed",
    (kind) => {
      const original =
        kind === "skill" ? skillReference("reflowed", skillBlock) : reference("reflowed");
      insert(original);
      const paragraph = original.block
        .split("\n")
        .slice(1, -1)
        .filter((line) => !line.startsWith("</team-"))
        .join(" ");
      setPrompt(thread, `My own opening. ${paragraph} My own ending.`);
      expect(draftTeamReferenceIds(thread, prompt())).toEqual(["reflowed"]);
      setPrompt(thread, prompt().replace("template", "checklist").replace("grant", "award"));
      expect(reconcileDraftTeamMemoryAccount(environmentA, "campus:bob").unresolved).toBe(1);
      expect(draftTeamReferenceIds(thread, prompt())).toEqual(["reflowed"]);
      removeDraftTeamMemory(thread);
      expect(draftTeamReferenceIds(thread, prompt())).toEqual(["reflowed"]);
      clearDraftTeamReferenceText(thread);
      expect(draftTeamReferenceIds(thread, prompt())).toEqual([]);
    },
  );

  it("preserves a queued message's references when a dirty edit returns to the draft", () => {
    const edit = DraftId.make("queued-edit:a");
    setPrompt(edit, "A heavily rewritten team note with my own additions");
    inheritDraftTeamReferences(edit, ["saved-reference"]);
    insert(reference("new-reference", edit));
    const moved = prompt(edit);
    useComposerDraftStore.getState().moveComposerPromptAndImages(edit, thread);
    moveDraftTeamMemory(edit, thread);
    expect(draftTeamReferenceIds(thread, moved)).toEqual(["saved-reference", "new-reference"]);
    expect(draftTeamReferenceIds(edit, "")).toEqual([]);
    // An account switch cannot silently remove opaque provenance and permit a new send.
    reconcileDraftTeamMemoryAccount(environmentA, "campus:bob");
    expect(draftTeamReferenceIds(thread, prompt())).toContain("saved-reference");
    send(thread, "failed");
    expect(draftTeamReferenceIds(thread, prompt())).toContain("saved-reference");
    clearDraftTeamReferenceText(thread);
    expect(prompt()).toBe("");
    expect(draftTeamReferenceIds(thread, prompt())).toEqual([]);
  });

  it("restores inherited queue provenance after draft-store rehydration", async () => {
    setPrompt(thread, "Edited team material retained after reload");
    inheritDraftTeamReferences(thread, ["saved-reference"]);
    const { storage, name } = useDraftTeamMemoryStore.persist.getOptions();
    if (storage === undefined || name === undefined)
      throw new Error("Draft storage is unavailable");
    const saved = await storage.getItem(name);
    if (saved === null) throw new Error("Draft provenance was not persisted");
    useDraftTeamMemoryStore.setState({ inheritedReferences: {} });
    await storage.setItem(name, saved);
    await useDraftTeamMemoryStore.persist.rehydrate();
    expect(draftTeamReferenceIds(thread, prompt())).toEqual(["saved-reference"]);
  });

  it("recovers 50 manual references plus the project's automatic skills without dropping protection", () => {
    const manual = Array.from(
      { length: MAX_DRAFT_TEAM_MEMORY },
      (_, index) => `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    );
    const automatic = Array.from(
      { length: MAX_TEAM_PROJECT_SKILLS },
      (_, index) => `11111111-1111-1111-1111-${String(index).padStart(12, "0")}`,
    );
    const edit = DraftId.make("queued-edit:full-context");
    const references = [...manual, ...automatic];
    expect(references).toHaveLength(MAX_TEAM_MESSAGE_REFERENCES);
    setPrompt(edit, "Edited text from a queued message with all approved team context");
    inheritDraftTeamReferences(edit, references);
    setPrompt(thread, prompt(edit));
    setPrompt(edit, "");
    moveDraftTeamMemory(edit, thread);
    expect(draftTeamReferenceIds(thread, prompt())).toEqual(references);
    expect(
      isTeamProjectCommand({
        action: "memory-verify",
        references: draftTeamReferenceIds(thread, prompt()),
      }),
    ).toBe(true);
    expect(insert(reference("extra"))).toEqual({ result: "full", inserted: false });
    send(thread, "failed");
    expect(draftTeamReferenceIds(thread, prompt())).toEqual(references);
    send(thread, "sent");
    expect(useDraftTeamMemoryStore.getState().inheritedReferences).toEqual({});
  });

  it("allows new notes up to the combined message limit and keeps other drafts independent", () => {
    setPrompt(thread, "A recovered queued message");
    inheritDraftTeamReferences(
      thread,
      Array.from({ length: MAX_DRAFT_TEAM_MEMORY }, (_, index) => `saved-${index}`),
    );
    for (let index = MAX_DRAFT_TEAM_MEMORY; index < MAX_TEAM_MESSAGE_REFERENCES; index++) {
      expect(
        insert(
          reference(
            `new-${index}`,
            thread,
            "campus:alice",
            note(`Memory/a/b/${index}.md`, "A new policy for this team."),
          ),
        ).result,
      ).toBe("added");
    }
    expect(draftTeamReferenceIds(thread, prompt())).toHaveLength(MAX_TEAM_MESSAGE_REFERENCES);
    expect(insert(reference("extra"))).toEqual({ result: "full", inserted: false });
    expect(insert(reference("other-draft", otherThread)).result).toBe("added");
  });

  it("counts inherited queued references before adding another note", () => {
    setPrompt(thread, "An edited queued message");
    inheritDraftTeamReferences(
      thread,
      Array.from({ length: MAX_TEAM_MESSAGE_REFERENCES }, (_, index) => `saved-${index}`),
    );
    expect(insert(reference("extra"))).toEqual({ result: "full", inserted: false });
    expect(prompt()).toBe("An edited queued message");
    send(thread, "queued");
    expect(useDraftTeamMemoryStore.getState().inheritedReferences).toEqual({});
  });

  it("retains failed sends and releases provenance to the server after enqueueing", () => {
    insert(reference("r1"));
    send(thread, "failed");
    expect(prompt()).toBe(block);
    expect(ids()).toEqual(["r1"]);
    // Native queues persist their own provenance; the client no longer mirrors queued text.
    send(thread, "queued");
    expect(prompt()).toBe("");
    expect(ids()).toEqual([]);
  });

  it("releases accepted references independently for each draft", () => {
    const draftId = DraftId.make("draft-a");
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(
        scopeProjectRef(environmentA, ProjectId.make("project-a")),
        draftId,
        { threadId: ThreadId.make("thread-draft") },
      );
    insert(reference("thread-note"));
    insert(reference("draft-note", draftId));
    send(thread, "queued");
    expect(ids()).toEqual(["draft-note"]);
    send(draftId, "queued");
    expect(ids()).toEqual([]);
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
  it("removes team skills beside memory without crossing into another block", () => {
    expect(
      removeTeamMemoryBlocks(`Ask ${skillBlock} and ${block} done`, [skillBlock, block]),
    ).toEqual({ prompt: "Ask and done", unresolved: [] });
    // An edited skill is removed through its own closing tag, not a memory note's.
    const edited = skillBlock.replace("grant checklist", "edited checklist");
    expect(removeTeamMemoryBlocks(`Ask ${edited} then`, [skillBlock]).prompt).toBe("Ask then");
    const withoutClosing = skillBlock.slice(0, skillBlock.lastIndexOf("\n"));
    expect(
      removeTeamMemoryBlocks(`${withoutClosing}\nMY OWN TEXT\n\n${block}\nlast`, [
        skillBlock,
        block,
      ]),
    ).toEqual({ prompt: `${withoutClosing}\nMY OWN TEXT\n\nlast`, unresolved: [skillBlock] });
    // Another skill's closing tag never ends an edited one, so the user's text between survives.
    expect(
      removeTeamMemoryBlocks(`${withoutClosing}\nMY OWN TEXT\n\n${secondSkill}\nlast`, [
        skillBlock,
        secondSkill,
      ]),
    ).toEqual({ prompt: `${withoutClosing}\nMY OWN TEXT\n\nlast`, unresolved: [skillBlock] });
    // The preamble every skill shares doesn't tie a deleted skill to another one left in the draft.
    const otherWithoutClosing = secondSkill.slice(0, secondSkill.lastIndexOf("\n"));
    expect(
      removeTeamMemoryBlocks(`Ask\n\n${otherWithoutClosing}`, [skillBlock, secondSkill]).unresolved,
    ).toEqual([secondSkill]);
  });

  it("tracks a team skill like memory through sending, sign-out, and the shared cap", () => {
    setPrompt(thread, "Draft");
    expect(insert(skillReference("s1")).result).toBe("added");
    insert(reference("m1"));
    expect(draftTeamMemoryInPrompt(thread, prompt()).map((entry) => entry.id)).toEqual([
      "s1",
      "m1",
    ]);
    send(thread, "failed");
    expect(ids()).toEqual(["s1", "m1"]);
    expect(reconcileDraftTeamMemoryAccount(environmentA, null)).toEqual({
      removed: 1,
      unresolved: 0,
    });
    expect(prompt()).toBe("Draft");
    expect(ids()).toEqual([]);
    reconcileDraftTeamMemoryAccount(environmentA, "campus:alice");
    // Memory and skills share one limit; a skill beyond it is refused before it is inserted.
    for (let index = 0; index < MAX_DRAFT_TEAM_MEMORY; index++)
      insert(reference(`r${index}`, threadAt(`thread-${index}`)));
    expect(insert(skillReference("s2"))).toEqual({ result: "full", inserted: false });
    expect(prompt()).toBe("Draft");
  });
});
