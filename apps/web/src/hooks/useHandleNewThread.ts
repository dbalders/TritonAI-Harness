import { useAtomValue } from "@effect/atom-react";
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
import { readProject, readThreadShell, useProjects, useThread } from "../state/entities";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { primaryServerSettingsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
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
  // New-thread defaults are a user preference, and the settings UI only ever
  // edits the primary environment's settings.json. Reading the target
  // environment's own settings here would silently reset remote projects to
  // the decoded defaults ("local" mode, current branch), since nothing can
  // set those values on a remote server.
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (projectRef: ScopedProjectRef, options?: NewThreadOptions): Promise<void> => {
      const {
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
        setModelSelection,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      // A new thread carries the user's *working mode* from the thread being
      // viewed: model (including options like reasoning effort and context
      // window), permission mode, and interaction mode. Branch, worktree, and
      // env mode never carry implicitly — those come from the configured
      // defaults unless the caller passes them explicitly.
      const carrySourceShell =
        currentRouteTarget?.kind === "server"
          ? readThreadShell(currentRouteTarget.threadRef)
          : null;
      const carrySourceDraft =
        currentRouteTarget?.kind === "draft" ? getDraftSession(currentRouteTarget.draftId) : null;
      // Composer overrides win over the persisted thread state — they are
      // what the user currently sees in the composer controls.
      const carrySourceComposer = currentRouteTarget
        ? getComposerDraft(
            currentRouteTarget.kind === "server"
              ? currentRouteTarget.threadRef
              : currentRouteTarget.draftId,
          )
        : null;
      const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
      const composerModelSelection = composerActiveProvider
        ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
        : null;
      const carryModelSelection =
        composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
      const carryRuntimeMode =
        carrySourceComposer?.runtimeMode ??
        carrySourceShell?.runtimeMode ??
        carrySourceDraft?.runtimeMode ??
        null;
      const carryInteractionMode =
        carrySourceComposer?.interactionMode ??
        carrySourceShell?.interactionMode ??
        carrySourceDraft?.interactionMode ??
        null;
      const project =
        projects.find(
          (candidate) =>
            candidate.id === projectRef.projectId &&
            candidate.environmentId === projectRef.environmentId,
        ) ?? readProject(projectRef);
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
          const isDraftAlreadyOpen =
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === reusableStoredDraftThread.draftId;
          const hasExplicitWorkspaceOption =
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasStartFromOriginOption;
          // Resurrecting a stored draft must not resurrect its stale context:
          // explicit workspace options win outright; otherwise the env context
          // resets to the configured defaults so drafts seeded before a
          // defaults change (or by the old carry-over behavior) stop landing
          // on "current checkout" branches forever. Composer text is
          // preserved. When the draft is already open and no options were
          // passed, leave it alone entirely — the user may have just picked a
          // branch in the composer.
          const defaultEnvMode = primaryServerSettings.defaultThreadEnvMode;
          const workspaceContext = hasExplicitWorkspaceOption
            ? {
                ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
                ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
                ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
                ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
              }
            : isDraftAlreadyOpen
              ? null
              : {
                  branch: null,
                  worktreePath: null,
                  envMode: defaultEnvMode,
                  startFromOrigin: resolveNewDraftStartFromOrigin({
                    envMode: defaultEnvMode,
                    newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
                  }),
                };
          if (workspaceContext) {
            setDraftThreadContext(reusableStoredDraftThread.draftId, {
              ...workspaceContext,
              ...(carryRuntimeMode ? { runtimeMode: carryRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            });
            if (carryModelSelection) {
              // The carried selection is a complete snapshot of the viewed
              // thread's model state: absent options mean "no options", not
              // "keep the stale draft's options".
              setModelSelection(reusableStoredDraftThread.draftId, carryModelSelection, {
                replaceOptions: true,
              });
            }
          }
          // The workspace context must also ride along here: when projectRef
          // targets a different physical member of the logical project,
          // createDraftThreadState treats the remap as a project change and
          // would otherwise wipe branch/worktree and force "local" mode,
          // undoing the write above.
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            reusableStoredDraftThread.draftId,
            {
              threadId: reusableStoredDraftThread.threadId,
              ...workspaceContext,
              ...(carryRuntimeMode ? { runtimeMode: carryRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
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
        environmentSettings: primaryServerSettings,
        ...(options ? { options } : {}),
      });
      if (carryRuntimeMode || carryInteractionMode) {
        setDraftThreadContext(draftId, {
          ...(carryRuntimeMode ? { runtimeMode: carryRuntimeMode } : {}),
          ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
        });
      }
      if (carryModelSelection) {
        setModelSelection(draftId, carryModelSelection, { replaceOptions: true });
      }

      return (async () => {
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          ...(options?.replace !== undefined ? { replace: options.replace } : {}),
        });
      })();
    },
    [getCurrentRouteTarget, primaryServerSettings, projectGroupingSettings, projects, router],
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
    return orderItemsByPreferredIds({
      items: projects,
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
