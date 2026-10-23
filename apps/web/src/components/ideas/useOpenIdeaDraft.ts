import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, Idea, ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useProjects } from "../../state/entities";
import { mergeIdeaPrompt } from "./ideaDraft";
import { getClientSettings } from "../../hooks/useSettings";
import { updateGettingStarted } from "../../onboarding/gettingStartedState";

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

  return useCallback(
    async (idea: Idea): Promise<{ readonly draftThreadId: ThreadId | null } | null> => {
      if (environmentId === null) return null;
      const { action } = idea;
      const store = useComposerDraftStore.getState();
      const guide = getClientSettings().gettingStarted;
      const trackIdea = async (threadId: ThreadId) => {
        if (!guide.startedAt || guide.environmentId !== environmentId || guide.paused) return;
        await updateGettingStarted({
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
        void trackIdea(action.threadId);
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
        void trackIdea(session.threadId);
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
      projectRef ??= fallback ? scopeProjectRef(environmentId, fallback.id) : null;
      if (projectRef === null) return null;

      const opened = await handleNewThread(projectRef, { newDraftPrompt: action.prompt });
      if (!opened) return null;
      // A reused draft keeps its own text, so the idea is added after it.
      const existing =
        useComposerDraftStore.getState().getComposerDraft(opened.draftId)?.prompt ?? "";
      const merged = mergeIdeaPrompt(existing, action.prompt);
      if (merged !== existing) store.setPrompt(opened.draftId, merged);
      void trackIdea(opened.threadId);
      return { draftThreadId: opened.threadId };
    },
    [environmentId, handleNewThread, navigate, openScratchProject, projects, scratchEnvironmentId],
  );
}
