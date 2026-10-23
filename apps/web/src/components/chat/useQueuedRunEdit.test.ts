import {
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  formatTeamMemoryContext,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  addDraftTeamMemory,
  draftTeamReferenceIds,
  reconcileDraftTeamMemoryAccount,
} from "../teams/teamMemoryDrafts";
import { submitQueuedRunEdit } from "./useQueuedRunEdit";

it("keeps team provenance when the account changes while a queued edit prepares attachments", async () => {
  const environmentId = EnvironmentId.make("queued-edit-account-transition");
  const draftTarget = DraftId.make("queued-edit:account-transition");
  const block = formatTeamMemoryContext({
    teamName: "Grant team",
    path: "Memory/grants/review.md",
    text: "Use the approved grant checklist.",
  });
  const store = useComposerDraftStore.getState();
  store.setPrompt(draftTarget, "");
  reconcileDraftTeamMemoryAccount(environmentId, "campus:alice");
  expect(
    addDraftTeamMemory(
      {
        id: "queued-edit-reference",
        thread: draftTarget,
        projectId: ProjectId.make("grants"),
        environmentId,
        identity: "campus:alice",
        teamName: "Grant team",
        path: "Memory/grants/review.md",
        block,
      },
      () => {
        store.setPrompt(draftTarget, block);
        return true;
      },
    ),
  ).toBe("added");
  const editQueuedRun = vi
    .fn<Parameters<typeof submitQueuedRunEdit>[0]["editQueuedRun"]>()
    .mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  const saved = submitQueuedRunEdit({
    environmentId,
    draftTarget,
    editing: {
      threadId: ThreadId.make("grant-thread"),
      runId: RunId.make("queued-grant-review"),
      messageId: MessageId.make("grant-message"),
      originalText: block,
      existingAttachments: [],
    },
    content: {
      prompt: block,
      images: [],
      files: [],
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: [],
      threadContexts: [],
    },
    editQueuedRun,
  });

  reconcileDraftTeamMemoryAccount(environmentId, null);
  expect(draftTeamReferenceIds(draftTarget, block)).toEqual([]);
  expect(await saved).toBeNull();
  // The server must still enforce access to the old payload, even though the draft removed it.
  expect(editQueuedRun).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      text: block,
      teamReferences: ["queued-edit-reference"],
    }),
  });
});
