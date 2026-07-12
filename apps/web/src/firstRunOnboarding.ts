import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { APP_BASE_NAME } from "./branding";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  useClientSettingsHydrated,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "./hooks/useSettings";
import { useNewThreadHandler } from "./hooks/useHandleNewThread";
import { inferProjectTitleFromPath } from "./lib/projectPaths";
import { newProjectId } from "./lib/utils";
import { readProject, useEnvironmentThreadRefs, useProjects } from "./state/entities";
import { usePrimaryEnvironmentId } from "./state/environments";
import { projectEnvironment } from "./state/projects";
import { environmentShell } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import {
  TRITONAI_CHATS_WORKSPACE,
  TRITONAI_FIRST_RUN_PROMPT,
  TRITONAI_FIRST_RUN_WORKSPACE,
  isTritonAiChatsWorkspacePath,
  isTritonAiCodeBrand,
  isTritonAiWorkspacePath,
  resolveTritonAiChatsWorkspacePath,
  resolveTritonAiFirstRunWorkspacePath,
} from "./tritonAiWorkspace";

const ONBOARDING_PROJECT_TITLE = "TritonAI";
const PROJECT_CREATE_WAIT_TIMEOUT_MS = 5_000;

const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
};
const EMPTY_SHELL_STATE_ATOM = Atom.make(EMPTY_SHELL_STATE);

export {
  TRITONAI_CHATS_WORKSPACE,
  TRITONAI_FIRST_RUN_PROMPT,
  TRITONAI_FIRST_RUN_WORKSPACE,
  isTritonAiChatsWorkspacePath,
  isTritonAiCodeBrand,
  isTritonAiWorkspacePath,
  resolveTritonAiChatsWorkspacePath,
  resolveTritonAiFirstRunWorkspacePath,
};

export function hasPriorProjectOrConversationState(input: {
  projectCount: number;
  nonOnboardingProjectCount: number;
  threadCount: number;
  draftThreadCount: number;
  composerDraftCount: number;
  existingTritonAiWorkspace: boolean;
}): boolean {
  if (input.threadCount > 0 || input.draftThreadCount > 0 || input.composerDraftCount > 0) {
    return true;
  }

  return input.nonOnboardingProjectCount > 0;
}

export function getTritonAiFirstRunOnboardingDecision(input: {
  isBranded: boolean;
  markerCompleted: boolean;
  clientSettingsHydrated: boolean;
  composerDraftsHydrated: boolean;
  primaryEnvironmentReady: boolean;
  primaryEnvironmentBootstrapped: boolean;
  routePathname: string;
  projectCount: number;
  nonOnboardingProjectCount: number;
  threadCount: number;
  draftThreadCount: number;
  composerDraftCount: number;
  existingTritonAiWorkspace: boolean;
}): "idle" | "defer" | "complete" | "run" {
  if (!input.isBranded || input.markerCompleted) return "idle";
  if (!input.clientSettingsHydrated || !input.composerDraftsHydrated) return "defer";
  if (!input.primaryEnvironmentReady || !input.primaryEnvironmentBootstrapped) return "defer";
  if (input.routePathname !== "/") return "defer";
  return hasPriorProjectOrConversationState(input) ? "complete" : "run";
}

export function shouldRunTritonAiFirstRunOnboarding(
  input: Parameters<typeof getTritonAiFirstRunOnboardingDecision>[0],
): boolean {
  return getTritonAiFirstRunOnboardingDecision(input) === "run";
}

function useComposerDraftStoreHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useComposerDraftStore.persist.hasHydrated());

  useEffect(() => {
    if (hydrated) return;
    return useComposerDraftStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
  }, [hydrated]);

  return hydrated;
}

function waitForProject(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  timeoutMs: number;
}): Promise<EnvironmentProject | null> {
  const projectRef = scopeProjectRef(input.environmentId, input.projectId);
  const immediate = readProject(projectRef);
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      const project = readProject(projectRef);
      if (project || Date.now() - startedAt >= input.timeoutMs) {
        resolve(project);
        return;
      }
      window.setTimeout(tick, 50);
    };
    window.setTimeout(tick, 50);
  });
}

export function TritonAiFirstRunOnboardingBootstrap(props: { pathname: string }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const createNewThread = useNewThreadHandler();
  const updateSettings = useUpdatePrimarySettings();
  const createProject = useAtomCommand(projectEnvironment.create, {
    label: "first-run TritonAI project create",
    reportFailure: false,
  });
  const clientSettingsHydrated = useClientSettingsHydrated();
  const composerDraftsHydrated = useComposerDraftStoreHydrated();
  const onboardingCompleted = usePrimarySettings(
    (settings) => settings.tritonAiFirstRunOnboardingCompleted,
  );
  const defaultModelSelection = usePrimarySettings(
    (settings) => settings.textGenerationModelSelection,
  );
  const projects = useProjects();
  const primaryThreadRefs = useEnvironmentThreadRefs(primaryEnvironmentId);
  const primaryShellState = useAtomValue(
    primaryEnvironmentId === null
      ? EMPTY_SHELL_STATE_ATOM
      : environmentShell.stateValueAtom(primaryEnvironmentId),
  );
  const draftStateSummary = useComposerDraftStore(
    useShallow((state) => ({
      draftThreadCount: Object.keys(state.draftThreadsByThreadKey).length,
      composerDraftCount: Object.keys(state.draftsByThreadKey).length,
    })),
  );
  const runningRef = useRef(false);

  useEffect(() => {
    if (!primaryEnvironmentId) return;

    const primaryProjects = projects.filter(
      (project) => project.environmentId === primaryEnvironmentId,
    );
    const existingTritonAiProject =
      primaryProjects.find((project) => isTritonAiWorkspacePath(project.workspaceRoot)) ?? null;
    const nonOnboardingProjectCount = primaryProjects.filter(
      (project) => !isTritonAiWorkspacePath(project.workspaceRoot),
    ).length;
    const primaryEnvironmentBootstrapped = Option.isSome(primaryShellState.snapshot);
    const decisionInput = {
      isBranded: isTritonAiCodeBrand(APP_BASE_NAME),
      markerCompleted: onboardingCompleted,
      clientSettingsHydrated,
      composerDraftsHydrated,
      primaryEnvironmentReady: true,
      primaryEnvironmentBootstrapped,
      routePathname: props.pathname,
      projectCount: primaryProjects.length,
      nonOnboardingProjectCount,
      threadCount: primaryThreadRefs.length,
      draftThreadCount: draftStateSummary.draftThreadCount,
      composerDraftCount: draftStateSummary.composerDraftCount,
      existingTritonAiWorkspace: existingTritonAiProject !== null,
    };

    const onboardingDecision = getTritonAiFirstRunOnboardingDecision(decisionInput);
    if (onboardingDecision === "idle" || onboardingDecision === "defer") return;
    if (onboardingDecision === "complete") {
      updateSettings({ tritonAiFirstRunOnboardingCompleted: true });
      return;
    }

    if (runningRef.current) {
      return;
    }

    runningRef.current = true;
    void (async () => {
      try {
        const workspacePath = resolveTritonAiFirstRunWorkspacePath();
        let project = existingTritonAiProject;

        if (!project) {
          const projectId = newProjectId();
          const result = await createProject({
            environmentId: primaryEnvironmentId,
            input: {
              projectId,
              title: inferProjectTitleFromPath(workspacePath) || ONBOARDING_PROJECT_TITLE,
              workspaceRoot: workspacePath,
              createWorkspaceRootIfMissing: true,
              defaultModelSelection,
            },
          });

          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) {
              console.error("[first-run-onboarding] project create failed", {
                error: squashAtomCommandFailure(result),
              });
            }
            return;
          }

          project = await waitForProject({
            environmentId: primaryEnvironmentId,
            projectId,
            timeoutMs: PROJECT_CREATE_WAIT_TIMEOUT_MS,
          });
        }

        if (!project) return;

        const projectRef = scopeProjectRef(project.environmentId, project.id);
        const currentDraftStore = useComposerDraftStore.getState();
        const existingProjectDraft = currentDraftStore.getDraftSessionByProjectRef(projectRef);
        if (existingProjectDraft) {
          updateSettings({ tritonAiFirstRunOnboardingCompleted: true });
          return;
        }

        await createNewThread(projectRef, {
          initialPrompt: TRITONAI_FIRST_RUN_PROMPT,
          replace: true,
        });
        updateSettings({ tritonAiFirstRunOnboardingCompleted: true });
      } catch (error) {
        console.error("[first-run-onboarding] failed", error);
      } finally {
        runningRef.current = false;
      }
    })();
  }, [
    clientSettingsHydrated,
    composerDraftsHydrated,
    createNewThread,
    createProject,
    defaultModelSelection,
    draftStateSummary.composerDraftCount,
    draftStateSummary.draftThreadCount,
    onboardingCompleted,
    primaryEnvironmentId,
    primaryShellState.snapshot,
    primaryThreadRefs.length,
    projects,
    props.pathname,
    updateSettings,
  ]);

  return null;
}
