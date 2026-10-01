import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { isElectron } from "../env";
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

const PLATFORM = { desktop: isElectron };

/**
 * In-memory coach state. `questStepIdByThreadId` maps drafts a step filled
 * with its example; a message sent from one finishes that step. `lastSend` is
 * the latest send and the steps it finished, so the conversation it happened
 * in can celebrate them. After a restart the person can fill an example again.
 */
interface CoachMemory {
  readonly questStepIdByThreadId: ReadonlyMap<string, string>;
  readonly lastSend: {
    readonly threadId: string;
    readonly completedStepIds: ReadonlyArray<string>;
  } | null;
}

let coachMemory: CoachMemory = { questStepIdByThreadId: new Map(), lastSend: null };
const coachListeners = new Set<() => void>();
const EMPTY_STEP_IDS: ReadonlyArray<string> = [];

function updateCoachMemory(next: CoachMemory): void {
  coachMemory = next;
  for (const listener of coachListeners) listener();
}

function subscribeCoachMemory(listener: () => void): () => void {
  coachListeners.add(listener);
  return () => coachListeners.delete(listener);
}

export function markGettingStartedQuestThread(threadId: ThreadId, stepId: string): void {
  const questStepIdByThreadId = new Map(coachMemory.questStepIdByThreadId);
  questStepIdByThreadId.set(threadId, stepId);
  updateCoachMemory({ ...coachMemory, questStepIdByThreadId });
}

/** The step whose example fills this draft, if any. */
export function useGettingStartedQuestStep(threadId: string | null): string | null {
  return useSyncExternalStore(subscribeCoachMemory, () =>
    threadId === null ? null : (coachMemory.questStepIdByThreadId.get(threadId) ?? null),
  );
}

/** Steps the latest message in this conversation finished. */
export function useJustCompletedGettingStartedSteps(
  threadId: string | null,
): ReadonlyArray<string> {
  return useSyncExternalStore(subscribeCoachMemory, () =>
    threadId !== null && coachMemory.lastSend?.threadId === threadId
      ? coachMemory.lastSend.completedStepIds
      : EMPTY_STEP_IDS,
  );
}

/**
 * Records finished steps. `announce` shows a toast; the coach celebrates steps
 * finished in a conversation itself, so only steps finished elsewhere (such as
 * connecting a plugin in Settings) need one.
 */
export function completeGettingStartedSteps(
  stepIds: ReadonlyArray<string>,
  options: { readonly announce?: boolean } = {},
): void {
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
  if (before.gettingStartedHidden || options.announce === false) return;
  const state = resolveGettingStartedState(progress, now, PLATFORM);
  const finished = state.steps.filter(
    (view) =>
      stepIds.includes(view.step.id) && before.gettingStartedProgress[view.step.id] === undefined,
  );
  const lastFinished = finished.at(-1);
  if (!lastFinished) return;
  const mainQuestJustFinished =
    state.isComplete &&
    !resolveGettingStartedState(before.gettingStartedProgress, now, PLATFORM).isComplete;
  toastManager.add(
    lastFinished.optional
      ? {
          type: "success",
          title: `Side quest complete: ${lastFinished.step.title}`,
          description: `${state.sideQuestsCompleted} of ${state.sideQuestsTotal} side quests done`,
          timeout: 6_000,
        }
      : mainQuestJustFinished
        ? {
            type: "success",
            title: "You finished getting started",
            description: "You know the basics. Side quests are there whenever you want more.",
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
  const state = resolveGettingStartedState(settings.gettingStartedProgress, new Date(), PLATFORM);
  if (state.steps.every((view) => view.status === "done")) {
    if (coachMemory.lastSend !== null) updateCoachMemory({ ...coachMemory, lastSend: null });
    return;
  }
  const questStepId = coachMemory.questStepIdByThreadId.get(event.threadId) ?? null;
  const completed = resolveStepsCompletedBySend(state, { ...event, questStepId });
  const questStepIdByThreadId = new Map(coachMemory.questStepIdByThreadId);
  if (questStepId !== null && completed.includes(questStepId)) {
    questStepIdByThreadId.delete(event.threadId);
  }
  updateCoachMemory({
    questStepIdByThreadId,
    lastSend: { threadId: event.threadId, completedStepIds: completed },
  });
  completeGettingStartedSteps(completed, { announce: false });
}

export function setGettingStartedHidden(hidden: boolean): void {
  void persistClientSettingsPatch({ gettingStartedHidden: hidden });
}

export function resetGettingStartedProgress(): void {
  updateCoachMemory({ questStepIdByThreadId: new Map(), lastSend: null });
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
  return { ...resolveGettingStartedState(progress, now, PLATFORM), hidden };
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

/** Opens a fresh draft in the project with a step's example filled in. */
export function useStartGettingStartedStepInNewDraft(): (
  projectRef: ScopedProjectRef,
  stepId: string,
  prompt: string,
) => Promise<void> {
  const handleNewThread = useNewThreadHandler();
  return useCallback(
    async (projectRef, stepId, prompt) => {
      const draft = await handleNewThread(projectRef);
      if (!draft) return;
      useComposerDraftStore.getState().setPrompt(draft.draftId, prompt);
      markGettingStartedQuestThread(draft.threadId, stepId);
    },
    [handleNewThread],
  );
}
