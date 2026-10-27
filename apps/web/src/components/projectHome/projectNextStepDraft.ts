import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectNextStep, ProjectOverview, ThreadId } from "@t3tools/contracts";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { mergeIdeaPrompt } from "../ideas/ideaDraft";
import { threadContextRecord } from "../../lib/composerContextRecords";

/** Keep the chosen action in the user's voice; source history travels as thread references. */
export function projectNextStepDraft(
  environmentId: EnvironmentId,
  overview: ProjectOverview,
  step: ProjectNextStep,
) {
  const sources = overview.sources.filter((source) => step.sources.includes(source.ref));
  return {
    prompt: step.title,
    threadContexts: sources.flatMap((source) =>
      source.threadId
        ? [threadContextRecord(scopeThreadRef(environmentId, source.threadId), source.title)]
        : [],
    ),
  };
}

export async function openProjectNextStepDraft(input: {
  environmentId: EnvironmentId;
  overview: ProjectOverview;
  step: ProjectNextStep;
  open: () => Promise<{ draftId: DraftId; threadId: ThreadId } | null>;
  admit: (threadId: ThreadId) => Promise<void>;
}) {
  const opened = await input.open();
  if (!opened) throw new Error("This project could not open a draft. Please try again.");
  await input.admit(opened.threadId);
  const { prompt, threadContexts } = projectNextStepDraft(
    input.environmentId,
    input.overview,
    input.step,
  );
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(opened.draftId)?.prompt ?? "";
  const merged = mergeIdeaPrompt(existing, prompt);
  if (merged !== existing) store.setPrompt(opened.draftId, merged);
  store.addThreadContexts(opened.draftId, threadContexts, { insertAtCaret: false });
}
