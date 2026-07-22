import { useRoute, type RouteProp } from "@react-navigation/native";
import { useMemo, useRef } from "react";
import {
  EnvironmentId,
  type OrchestrationThread,
  ThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";

import { useProject, useThreadShell } from "../state/entities";
import { useEnvironmentThread } from "../state/threads";
import {
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnection,
} from "./use-remote-environment-registry";
type ThreadSelectionRouteParams = {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
};

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function latestUserMessageAt(thread: OrchestrationThread): OrchestrationThread["updatedAt"] | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "user") {
      return message.createdAt;
    }
  }

  return null;
}

function pendingRequestFlags(thread: OrchestrationThread): {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
} {
  const approvals = new Set<string>();
  const userInput = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : "";
    if (activity.kind === "approval.requested") approvals.add(requestId);
    if (activity.kind === "approval.resolved") approvals.delete(requestId);
    if (activity.kind === "user-input.requested") userInput.add(requestId);
    if (activity.kind === "user-input.resolved") userInput.delete(requestId);
    if (
      activity.kind === "provider.approval.respond.failed" &&
      (detail.includes("stale pending approval request") ||
        detail.includes("unknown pending approval request") ||
        detail.includes("unknown pending permission request"))
    ) {
      approvals.delete(requestId);
    }
    if (
      activity.kind === "provider.user-input.respond.failed" &&
      (detail.includes("stale pending user-input request") ||
        detail.includes("unknown pending user-input request") ||
        detail.includes("unknown pending user input request") ||
        detail.includes("unknown pending codex user input request"))
    ) {
      userInput.delete(requestId);
    }
  }
  return {
    hasPendingApprovals: approvals.size > 0,
    hasPendingUserInput: userInput.size > 0,
  };
}

function hasActionableProposedPlan(thread: OrchestrationThread): boolean {
  const sorted = thread.proposedPlans.toSorted(
    (left, right) =>
      left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
  );
  const latestTurnPlan = thread.latestTurn
    ? sorted.findLast((plan) => plan.turnId === thread.latestTurn?.turnId)
    : undefined;
  const candidate = latestTurnPlan ?? sorted.at(-1);
  return candidate !== undefined && candidate.implementedAt === null;
}

function threadDetailToShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThread,
): EnvironmentThreadShell {
  const pending = pendingRequestFlags(thread);
  return {
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    session: thread.session,
    latestUserMessageAt: latestUserMessageAt(thread),
    hasPendingApprovals: pending.hasPendingApprovals,
    hasPendingUserInput: pending.hasPendingUserInput,
    hasActionableProposedPlan: hasActionableProposedPlan(thread),
  };
}

function useResolvedThreadSelection(params: ThreadSelectionRouteParams | undefined) {
  const routeParams = params ?? {};
  const routeThreadRef = useMemo<ScopedThreadRef | null>(() => {
    const environmentId = firstRouteParam(routeParams.environmentId);
    const threadId = firstRouteParam(routeParams.threadId);
    if (!environmentId || !threadId) {
      return null;
    }

    return {
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(threadId),
    };
  }, [routeParams.environmentId, routeParams.threadId]);
  const lastRouteThreadRef = useRef<ScopedThreadRef | null>(null);
  if (routeThreadRef !== null) {
    lastRouteThreadRef.current = routeThreadRef;
  }
  const selectedThreadRef = routeThreadRef ?? lastRouteThreadRef.current;
  const selectedThreadShell = useThreadShell(selectedThreadRef);
  const selectedThreadDetailState = useEnvironmentThread(
    selectedThreadRef?.environmentId ?? null,
    selectedThreadRef?.threadId ?? null,
  );
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const selectedThread = useMemo(
    () =>
      selectedThreadShell ??
      (selectedThreadRef !== null && selectedThreadDetail !== null
        ? threadDetailToShell(selectedThreadRef.environmentId, selectedThreadDetail)
        : null),
    [selectedThreadDetail, selectedThreadRef, selectedThreadShell],
  );
  const selectedProjectRef = useMemo<ScopedProjectRef | null>(
    () =>
      selectedThread === null
        ? null
        : {
            environmentId: selectedThread.environmentId,
            projectId: selectedThread.projectId,
          },
    [selectedThread],
  );
  const selectedThreadProject = useProject(selectedProjectRef);
  const selectedEnvironmentId = selectedThread?.environmentId ?? null;
  const selectedEnvironmentConnection = useSavedRemoteConnection(selectedEnvironmentId);
  const selectedEnvironmentRuntime = useRemoteEnvironmentRuntime(selectedEnvironmentId);

  return useMemo(
    () => ({
      selectedThreadRef,
      selectedThread,
      selectedThreadProject,
      selectedEnvironmentConnection,
      selectedEnvironmentRuntime,
    }),
    [
      selectedEnvironmentConnection,
      selectedEnvironmentRuntime,
      selectedThread,
      selectedThreadProject,
      selectedThreadRef,
    ],
  );
}

type ThreadSelectionState = ReturnType<typeof useResolvedThreadSelection>;

export function useThreadSelection(): ThreadSelectionState {
  const route = useRoute<RouteProp<Record<string, ThreadSelectionRouteParams | undefined>>>();
  return useResolvedThreadSelection(route.params);
}
