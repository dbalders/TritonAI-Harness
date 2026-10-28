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
 * Open thread ideas in their composer; otherwise create a draft in the idea, scratch,
 * or first project. Return the eventual thread ID, or null when no project exists.
 */
export function useOpenIdeaDraft(environmentId: EnvironmentId | null) {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const projects = useProjects();

  return async (idea: Idea): Promise<{ readonly draftThreadId: ThreadId | null } | null> => {
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

    const opened = await handleNewThread(projectRef, { newDraftPrompt: action.prompt });
    if (!opened) return null;
    // A reused draft keeps its own text, so the idea is added after it.
    const existing =
      useComposerDraftStore.getState().getComposerDraft(opened.draftId)?.prompt ?? "";
    const merged = mergeIdeaPrompt(existing, action.prompt);
    if (merged !== existing) store.setPrompt(opened.draftId, merged);
    trackIdea(opened.threadId);
    return { draftThreadId: opened.threadId };
  };
}
