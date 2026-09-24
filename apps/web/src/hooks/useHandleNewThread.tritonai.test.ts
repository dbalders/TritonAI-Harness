import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { TRITONAI_FIRST_RUN_PROMPT } from "../tritonAiWorkspace";
import { seedNewDraftPrompt } from "./useHandleNewThread";

const DRAFT_ID = DraftId.make("draft-tritonai-onboarding");

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
    stickyRuntimeMode: null,
  });
}

describe("seedNewDraftPrompt", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    useComposerDraftStore.getState().setPrompt(DRAFT_ID, "");
  });

  it("seeds the TritonAI onboarding prompt through the new-thread path", () => {
    seedNewDraftPrompt(DRAFT_ID, TRITONAI_FIRST_RUN_PROMPT);

    expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe(
      TRITONAI_FIRST_RUN_PROMPT,
    );
  });

  it("leaves a new draft unchanged when no seed prompt is provided", () => {
    seedNewDraftPrompt(DRAFT_ID, undefined);

    expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt ?? "").toBe("");
  });
});
