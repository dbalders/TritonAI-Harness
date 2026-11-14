import { type MessageId, type RuntimeRequestId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { type ComposerSubmissionIntent } from "../../composer-logic";
import { type SessionPhase, type Thread } from "../../types";
import {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "../ChatView.logic";

const LOCAL_DISPATCH_HANDOFF_TTL_MS = 10 * 60 * 1000;
const MAX_LOCAL_DISPATCH_HANDOFFS = 32;
interface LocalDispatchHandoff {
  dispatch: LocalDispatchSnapshot;
  expiresAt: number;
}
const localDispatchHandoffs = new Map<string, LocalDispatchHandoff>();

function readLocalDispatchHandoff(threadKey: string): LocalDispatchSnapshot | null {
  const handoff = localDispatchHandoffs.get(threadKey);
  if (!handoff) return null;
  if (handoff.expiresAt <= Date.now()) {
    localDispatchHandoffs.delete(threadKey);
    return null;
  }
  return handoff.dispatch;
}

function writeLocalDispatchHandoff(threadKey: string, dispatch: LocalDispatchSnapshot): void {
  const now = Date.now();
  for (const [key, handoff] of localDispatchHandoffs) {
    if (handoff.expiresAt <= now) {
      localDispatchHandoffs.delete(key);
    }
  }
  localDispatchHandoffs.delete(threadKey);
  localDispatchHandoffs.set(threadKey, {
    dispatch,
    expiresAt: now + LOCAL_DISPATCH_HANDOFF_TTL_MS,
  });
  while (localDispatchHandoffs.size > MAX_LOCAL_DISPATCH_HANDOFFS) {
    const oldestKey = localDispatchHandoffs.keys().next().value;
    if (oldestKey === undefined) break;
    localDispatchHandoffs.delete(oldestKey);
  }
}

function clearLocalDispatchHandoff(threadKey: string, dispatch?: LocalDispatchSnapshot): void {
  const handoff = localDispatchHandoffs.get(threadKey);
  if (!handoff || (dispatch && handoff.dispatch !== dispatch)) {
    return;
  }
  localDispatchHandoffs.delete(threadKey);
}

export function useLocalDispatchState(input: {
  threadKey: string;
  activeThread: Thread | undefined;
  activeLatestRun: Thread["latestRun"] | null;
  latestUserMessageId: MessageId | null;
  phase: SessionPhase;
  activePendingApproval: RuntimeRequestId | null;
  activePendingUserInput: RuntimeRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(() =>
    readLocalDispatchHandoff(input.threadKey),
  );

  const resetLocalDispatch = () => {
    clearLocalDispatchHandoff(input.threadKey);
    setLocalDispatch(null);
  };

  const serverAcknowledgedLocalDispatch = hasServerAcknowledgedLocalDispatch({
    localDispatch,
    phase: input.phase,
    latestRun: input.activeLatestRun,
    latestUserMessageId: input.latestUserMessageId,
    runtime: input.activeThread?.runtime ?? null,
    hasPendingApproval: input.activePendingApproval !== null,
    hasPendingUserInput: input.activePendingUserInput !== null,
    threadError: input.threadError,
  });
  const activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch;
  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch || !localDispatch) return;
    clearLocalDispatchHandoff(input.threadKey, localDispatch);
  }, [input.threadKey, localDispatch, serverAcknowledgedLocalDispatch]);
  useEffect(() => {
    if (!localDispatch) return;
    const parsedStartedAt = Date.parse(localDispatch.startedAt);
    const expiresAt =
      (Number.isNaN(parsedStartedAt) ? Date.now() : parsedStartedAt) +
      LOCAL_DISPATCH_HANDOFF_TTL_MS;
    const timeoutId = window.setTimeout(
      () => {
        clearLocalDispatchHandoff(input.threadKey, localDispatch);
        setLocalDispatch((current) => (current === localDispatch ? null : current));
      },
      Math.max(0, expiresAt - Date.now()),
    );
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [input.threadKey, localDispatch]);
  const beginLocalDispatch = (options?: {
    preparingWorktree?: boolean;
    submissionIntent?: ComposerSubmissionIntent;
  }) => {
    const preparingWorktree = Boolean(options?.preparingWorktree);
    setLocalDispatch((current) => {
      const active = serverAcknowledgedLocalDispatch ? null : current;
      const submissionIntent =
        options?.submissionIntent ?? active?.submissionIntent ?? "foreground";
      const next = active
        ? active.preparingWorktree === preparingWorktree &&
          active.submissionIntent === submissionIntent
          ? active
          : { ...active, preparingWorktree, submissionIntent }
        : createLocalDispatchSnapshot(input.activeThread, {
            ...options,
            latestUserMessageId: input.latestUserMessageId,
          });
      writeLocalDispatchHandoff(input.threadKey, next);
      return next;
    });
  };

  return {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt: activeLocalDispatch?.startedAt ?? null,
    isPreparingWorktree: activeLocalDispatch?.preparingWorktree ?? false,
    isSendBusy: activeLocalDispatch !== null,
    backgroundSubmissionPending: activeLocalDispatch?.submissionIntent === "background",
  };
}
