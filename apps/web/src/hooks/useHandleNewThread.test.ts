import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import { TRITONAI_FIRST_RUN_PROMPT } from "../tritonAiWorkspace";
import { createNewThreadDraft } from "./useHandleNewThread";

const PROJECT_REF = scopeProjectRef(
  EnvironmentId.make("primary"),
  ProjectId.make("tritonai-onboarding"),
);

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("createNewThreadDraft", () => {
  beforeEach(resetComposerDraftStore);

  it("seeds the onboarding prompt through the canonical new-thread path", () => {
    const draftId = createNewThreadDraft({
      projectRef: PROJECT_REF,
      logicalProjectKey: "tritonai-onboarding",
      environmentSettings: {
        defaultThreadEnvMode: "local",
        newWorktreesStartFromOrigin: false,
      },
      options: { initialPrompt: TRITONAI_FIRST_RUN_PROMPT },
    });

    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      TRITONAI_FIRST_RUN_PROMPT,
    );
    expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(1);
  });

  it("honors worktree and start-from-origin environment preferences", () => {
    const draftId = createNewThreadDraft({
      projectRef: PROJECT_REF,
      logicalProjectKey: "tritonai-onboarding",
      environmentSettings: {
        defaultThreadEnvMode: "worktree",
        newWorktreesStartFromOrigin: true,
      },
    });

    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      envMode: "worktree",
      startFromOrigin: true,
    });
  });
});
