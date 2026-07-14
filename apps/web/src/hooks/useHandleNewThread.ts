import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { DEFAULT_SERVER_SETTINGS, type ScopedProjectRef } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import {
  markPromotedDraftThreadByRef,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  readProject,
  readThreadShell,
  useProjects,
  useServerConfigs,
  useThread,
} from "../state/entities";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { isTritonAiChatsWorkspacePath } from "../tritonAiWorkspace";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

interface NewThreadOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
  /** Seeds only a newly created draft; reused drafts keep their existing composer content. */
  newDraftPrompt?: string;
  replace?: boolean;
}

export function createNewThreadDraft(input: {
  projectRef: ScopedProjectRef;
  logicalProjectKey: string;
  environmentSettings: Pick<
    typeof DEFAULT_SERVER_SETTINGS,
    "defaultThreadEnvMode" | "newWorktreesStartFromOrigin"
  >;
  options?: NewThreadOptions;
}) {
  const draftId = newDraftId();
  const initialEnvMode = input.options?.envMode ?? input.environmentSettings.defaultThreadEnvMode;
  const { applyStickyState, setLogicalProjectDraftThreadId, setPrompt } =
    useComposerDraftStore.getState();

  setLogicalProjectDraftThreadId(input.logicalProjectKey, input.projectRef, draftId, {
    threadId: newThreadId(),
    createdAt: new Date().toISOString(),
    branch: input.options?.branch ?? null,
    worktreePath: input.options?.worktreePath ?? null,
    envMode: initialEnvMode,
    startFromOrigin:
      input.options?.startFromOrigin ??
      resolveNewDraftStartFromOrigin({
        envMode: initialEnvMode,
        newWorktreesStartFromOrigin: input.environmentSettings.newWorktreesStartFromOrigin,
      }),
  });
  applyStickyState(draftId);
  if (input.options?.newDraftPrompt !== undefined) {
    setPrompt(draftId, input.options.newDraftPrompt);
  }

  return draftId;
}

export function useNewThreadHandler() {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (projectRef: ScopedProjectRef, options?: NewThreadOptions): Promise<void> => {
      const {
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      const project =
        projects.find(
          (candidate) =>
            candidate.id === projectRef.projectId &&
            candidate.environmentId === projectRef.environmentId,
        ) ?? readProject(projectRef);
      const environmentSettings =
        serverConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedDraftThreadRef = storedDraftThread
        ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
        : null;
      const reusableStoredDraftThread =
        storedDraftThreadRef && readThreadShell(storedDraftThreadRef) !== null
          ? null
          : storedDraftThread;
      if (storedDraftThreadRef && reusableStoredDraftThread === null) {
        markPromotedDraftThreadByRef(storedDraftThreadRef);
      }
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (reusableStoredDraftThread) {
        return (async () => {
          if (
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasStartFromOriginOption
          ) {
            setDraftThreadContext(reusableStoredDraftThread.draftId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
              ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
            });
          }
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            reusableStoredDraftThread.draftId,
            {
              threadId: reusableStoredDraftThread.threadId,
            },
          );
          if (
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === reusableStoredDraftThread.draftId
          ) {
            return;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: reusableStoredDraftThread.draftId },
            ...(options?.replace !== undefined ? { replace: options.replace } : {}),
          });
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null
      ) {
        if (
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasStartFromOriginOption
        ) {
          setDraftThreadContext(currentRouteTarget.draftId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
          });
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
        });
        return Promise.resolve();
      }

      const draftId = createNewThreadDraft({
        projectRef,
        logicalProjectKey,
        environmentSettings,
        ...(options ? { options } : {}),
      });
      return (async () => {
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          ...(options?.replace !== undefined ? { replace: options.replace } : {}),
        });
      })();
    },
    [getCurrentRouteTarget, projectGroupingSettings, projects, router, serverConfigs],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useThread(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    const visibleProjects = projects.filter(
      (project) => !isTritonAiChatsWorkspacePath(project.workspaceRoot),
    );
    return orderItemsByPreferredIds({
      items: visibleProjects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeThreadRef,
  };
}
