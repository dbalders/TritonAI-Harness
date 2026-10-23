import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, GettingStartedChapterId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useTritonAiProject } from "./useTritonAiProject";
import { useComposerDraftStore } from "../composerDraftStore";
import { getClientSettings } from "../hooks/useSettings";
import { mergeIdeaPrompt } from "../components/ideas/ideaDraft";
import { getGettingStartedPreparationRevision, updateGettingStarted } from "./gettingStartedState";

/** Prepare an ordinary editable draft. The guide never starts an agent turn itself. */
export function useGettingStartedActions(environmentId: EnvironmentId | null) {
  const router = useRouter();
  const preparingRef = useRef(false);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const handleNewThread = useNewThreadHandler();
  const openPracticeProject = useTritonAiProject(environmentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prepare = async (
    chapter: GettingStartedChapterId,
    prompt: string,
    toolNames: ReadonlyArray<string> = [],
  ) => {
    if (
      !environmentId ||
      preparingRef.current ||
      !getClientSettings().experimentalGuidedTourEnabled
    )
      return;
    preparingRef.current = true;
    const generation = getClientSettings().gettingStarted.generation;
    const preparationRevision = getGettingStartedPreparationRevision();
    const originHref = router.state.location.href;
    const stillOwned = () => {
      const current = getClientSettings().gettingStarted;
      return (
        getGettingStartedPreparationRevision() === preparationRevision &&
        getClientSettings().experimentalGuidedTourEnabled &&
        current.generation === generation &&
        current.environmentId === environmentId &&
        !current.paused &&
        current.activeChapter === chapter
      );
    };
    setPending(true);
    setError(null);
    try {
      const config = serverConfigs.get(environmentId);
      if (!config) throw new Error("Still connecting to the assistant. Try again in a moment.");
      if (
        !resolveDefaultProviderModelSelection(
          config.providers,
          config.settings.defaultModelSelection,
        )
      ) {
        throw new Error("Set up an AI model in Settings → Runtime, then return here to practice.");
      }
      const project = await openPracticeProject();
      if (!project)
        throw new Error("Could not open the TritonAI workspace. Try again in a moment.");
      if (!stillOwned() || router.state.location.href !== originHref) return;
      const opened = await handleNewThread(scopeProjectRef(environmentId, project.id), {
        isCurrent: stillOwned,
        envMode: "local",
        branch: null,
        worktreePath: null,
      });
      if (!opened || !stillOwned()) return;
      const store = useComposerDraftStore.getState();
      const existing = store.getComposerDraft(opened.draftId)?.prompt ?? "";
      store.setPrompt(opened.draftId, mergeIdeaPrompt(existing, prompt));
      store.setRuntimeMode(opened.draftId, "approval-required");
      if (
        await updateGettingStarted({
          type: "track",
          chapter,
          environmentId,
          threadId: opened.threadId,
          at: new Date().toISOString(),
          toolNames,
          generation,
        })
      ) {
        await updateGettingStarted({ type: "close", generation, fromChapter: chapter });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare this task. Try again.");
    } finally {
      preparingRef.current = false;
      setPending(false);
    }
  };
  return { prepare, pending, error };
}
