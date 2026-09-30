import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { toastManager } from "../components/ui/toast";
import {
  sortScopedProjectsForSidebar,
  sortThreadsByActivityForSidebar,
} from "../components/Sidebar.logic";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  getClientSettings,
  persistClientSettingsPatch,
  persistClientSettingsUpdate,
  useClientSettings,
} from "../hooks/useSettings";
import { useProjects, useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { isTritonAiWorkspacePath } from "../tritonAiWorkspace";
import {
  mergeGettingStartedProgress,
  resolveGettingStartedState,
  resolveStepsCompletedBySend,
  type GettingStartedSendEvent,
  type GettingStartedState,
} from "./gettingStarted.logic";

/**
 * Drafts a guide step filled with its example, by thread id. A message sent
 * from one of them finishes that step. Kept in memory: after a restart the
 * person can fill the example again.
 */
const questStepIdByThreadId = new Map<string, string>();

export function markGettingStartedQuestThread(threadId: ThreadId, stepId: string): void {
  questStepIdByThreadId.set(threadId, stepId);
}

export function completeGettingStartedSteps(stepIds: ReadonlyArray<string>): void {
  if (stepIds.length === 0) return;
  const before = getClientSettings();
  const now = new Date();
  const progress = mergeGettingStartedProgress(
    before.gettingStartedProgress,
    stepIds,
    now.toISOString(),
  );
  if (progress === before.gettingStartedProgress) return;

  void persistClientSettingsUpdate((current) => ({
    ...current,
    gettingStartedProgress: mergeGettingStartedProgress(
      current.gettingStartedProgress,
      stepIds,
      now.toISOString(),
    ),
  }));

  // Someone who hid the guide still earns progress, just without the fanfare.
  if (before.gettingStartedHidden) return;
  const state = resolveGettingStartedState(progress, now);
  const finished = state.steps.filter(
    (view) =>
      stepIds.includes(view.step.id) && before.gettingStartedProgress[view.step.id] === undefined,
  );
  const lastFinished = finished.at(-1);
  if (!lastFinished) return;
  toastManager.add(
    state.isComplete
      ? {
          type: "success",
          title: "You finished getting started",
          description: "You know the basics. Keep asking for help with real work.",
          timeout: 8_000,
        }
      : {
          type: "success",
          title: `Step complete: ${lastFinished.step.title}`,
          description: `${state.completedCount} of ${state.total} done${
            state.nextStep ? ` · Next: ${state.nextStep.step.title}` : ""
          }`,
          timeout: 6_000,
        },
  );
}

/** Called after a message is sent successfully. */
export function recordGettingStartedSend(
  event: Omit<GettingStartedSendEvent, "questStepId"> & { readonly threadId: ThreadId },
): void {
  const settings = getClientSettings();
  const state = resolveGettingStartedState(settings.gettingStartedProgress, new Date());
  if (state.isComplete) return;
  const questStepId = questStepIdByThreadId.get(event.threadId) ?? null;
  const completed = resolveStepsCompletedBySend(state, { ...event, questStepId });
  if (questStepId !== null && completed.includes(questStepId)) {
    questStepIdByThreadId.delete(event.threadId);
  }
  completeGettingStartedSteps(completed);
}

export function setGettingStartedHidden(hidden: boolean): void {
  void persistClientSettingsPatch({ gettingStartedHidden: hidden });
}

export function resetGettingStartedProgress(): void {
  questStepIdByThreadId.clear();
  void persistClientSettingsPatch({ gettingStartedProgress: {}, gettingStartedHidden: false });
}

/** A day boundary unlocks steps, so re-read the clock when the window returns. */
function useNowOnFocus(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const refresh = () => setNow(new Date());
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return now;
}

export function useGettingStartedState(): GettingStartedState & { readonly hidden: boolean } {
  const progress = useClientSettings((settings) => settings.gettingStartedProgress);
  const hidden = useClientSettings((settings) => settings.gettingStartedHidden);
  const now = useNowOnFocus();
  return { ...resolveGettingStartedState(progress, now), hidden };
}

/** Shows the guide again and opens a fresh draft where it appears. */
export function useOpenGettingStartedGuide(): () => Promise<void> {
  const projects = useProjects();
  const threads = useThreadShells();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();

  return useCallback(async () => {
    setGettingStartedHidden(false);
    const project =
      projects.find(
        (candidate) =>
          candidate.environmentId === primaryEnvironmentId &&
          isTritonAiWorkspacePath(candidate.workspaceRoot),
      ) ??
      sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ??
      null;
    if (!project) {
      await navigate({ to: "/" });
      return;
    }
    await handleNewThread(scopeProjectRef(project.environmentId, project.id));
  }, [handleNewThread, navigate, primaryEnvironmentId, projects, threads]);
}

export function useOpenLatestConversation(): (() => Promise<void>) | null {
  const threads = useThreadShells();
  const navigate = useNavigate();
  const latest =
    sortThreadsByActivityForSidebar(threads.filter((thread) => thread.archivedAt === null))[0] ??
    null;
  const open = useCallback(async () => {
    if (!latest) return;
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(latest.environmentId, latest.id)),
    });
  }, [latest, navigate]);
  return latest ? open : null;
}
