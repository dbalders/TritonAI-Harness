import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, Idea, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useProjects } from "../../state/entities";
import { getClientSettings } from "../../hooks/useSettings";
import { updateGettingStarted } from "../../onboarding/gettingStartedState";
import { mergeIdeaPrompt } from "./ideaDraft";

/**
 * Opens an idea as a draft the user reviews before sending. Ideas about a
 * thread fill that thread's composer; the rest start a new thread in the
 * idea's project, else the scratch project, else the first project.
 * Resolves with the thread the new draft becomes when sent, or null when there
 * is nowhere to put the draft.
 */
export function useOpenIdeaDraft(environmentId: EnvironmentId | null) {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const projects = useProjects();

  return async (
    idea: Idea,
    beforePrompt: (draftThreadId: ThreadId | null) => Promise<boolean>,
  ): Promise<{ readonly draftThreadId: ThreadId | null } | null> => {
    if (environmentId === null) return null;
    const { action } = idea;
    const store = useComposerDraftStore.getState();
    const guide = getClientSettings().gettingStarted;
    const trackIdea = (threadId: ThreadId) => {
      if (!guide.startedAt || guide.environmentId !== environmentId || guide.paused) return;
      void updateGettingStarted({
        type: "track",
        chapter: "ideas",
        environmentId,
        threadId,
        at: new Date().toISOString(),
        generation: guide.generation,
      });
    };

    if (action.kind === "resume-thread") {
      if (!(await beforePrompt(null))) return null;
      const threadRef = scopeThreadRef(environmentId, action.threadId);
      const existing = store.getComposerDraft(threadRef)?.prompt ?? "";
      store.setPrompt(threadRef, mergeIdeaPrompt(existing, action.prompt));
      trackIdea(action.threadId);
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: action.threadId },
      });
      return { draftThreadId: null };
    }

    // Opening the same idea again returns to the draft it already started, even after
    // the user edited it. Drafts are matched by the thread recorded when the idea was
    // opened, never by text, which another idea's draft could share.
    const reopened = Object.entries(store.draftThreadsByThreadKey).find(
      ([, session]) =>
        session.promotedTo == null &&
        session.environmentId === environmentId &&
        idea.draftThreadIds.includes(session.threadId),
    );
    if (reopened) {
      const [draftKey, session] = reopened;
      if (!(await beforePrompt(session.threadId))) return null;
      trackIdea(session.threadId);
      await navigate({ to: "/draft/$draftId", params: { draftId: DraftId.make(draftKey) } });
      return { draftThreadId: session.threadId };
    }

    let projectRef: ScopedProjectRef | null =
      action.projectId !== null &&
      projects.some(
        (project) => project.environmentId === environmentId && project.id === action.projectId,
      )
        ? scopeProjectRef(environmentId, action.projectId)
        : null;
    if (projectRef === null && scratchEnvironmentId(environmentId) !== null) {
      const scratch = await openScratchProject(environmentId);
      if (scratch) projectRef = scopeProjectRef(scratch.environmentId, scratch.id);
    }
    const fallback = projects.find((project) => project.environmentId === environmentId);
    projectRef = projectRef ?? (fallback ? scopeProjectRef(environmentId, fallback.id) : null);
    if (projectRef === null) return null;

    const opened = await handleNewThread(projectRef);
    if (!opened) return null;
    // An empty draft may open while this is pending; generated text becomes sendable only
    // after the host has persisted its provenance on the destination thread.
    if (!(await beforePrompt(opened.threadId))) return null;
    // A reused draft keeps its own text, so the idea is added after it.
    const existing =
      useComposerDraftStore.getState().getComposerDraft(opened.draftId)?.prompt ?? "";
    const merged = mergeIdeaPrompt(existing, action.prompt);
    if (merged !== existing) store.setPrompt(opened.draftId, merged);
    trackIdea(opened.threadId);
    return { draftThreadId: opened.threadId };
  };
}
