import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  COMPOSER_QUEUE_ACKNOWLEDGEMENT_TIMEOUT_MS,
  useComposerQueueStore,
} from "../../composerQueueStore";
import { derivePendingUserInputs, derivePhase } from "../../session-logic";
import { useThreadDetail, useThreadStatus } from "../../state/entities";
import { usePreparedConnection } from "../../state/session";
import { revokeBlobPreviewUrl } from "../ChatView.logic";
import { canAutoDrainComposerQueue, resolveQueuedAcknowledgement } from "./composerDispatch";
import { dispatchQueuedComposerEntry } from "./dispatchQueuedComposerEntry";

const EMPTY_QUEUED_COMPOSER_ENTRIES = [] as const;

function QueuedThreadDrain({ threadKey }: { readonly threadKey: string }) {
  const threadRef = parseScopedThreadKey(threadKey);
  const thread = useThreadDetail(threadRef);
  const threadStatus = useThreadStatus(threadRef);
  const preparedConnection = usePreparedConnection(threadRef?.environmentId ?? null);
  const isEnvironmentConnected = Option.isSome(preparedConnection);
  const entries = useComposerQueueStore(
    (state) => state.entriesByThreadKey[threadKey] ?? EMPTY_QUEUED_COMPOSER_ENTRIES,
  );
  const dispatchOwner = useComposerQueueStore((state) => state.dispatchOwnerByThreadKey[threadKey]);
  const acknowledgementMessageId = useComposerQueueStore(
    (state) => state.dispatchAcknowledgementByThreadKey[threadKey],
  );
  const previousTurnId = useComposerQueueStore(
    (state) => state.dispatchPreviousTurnIdByThreadKey[threadKey],
  );
  const acknowledgementDeadline = useComposerQueueStore(
    (state) => state.dispatchAcknowledgementDeadlineByThreadKey[threadKey],
  );
  const sharedDispatchCount = useComposerQueueStore(
    (state) => state.sharedDispatchCountByThreadKey[threadKey] ?? 0,
  );
  const phase = derivePhase(thread?.session ?? null);
  const hasPendingUserInput = derivePendingUserInputs(thread?.activities ?? []).length > 0;
  const [acknowledgementWake, setAcknowledgementWake] = useState(0);

  useEffect(() => {
    if (!dispatchOwner || !acknowledgementMessageId || acknowledgementDeadline === undefined) {
      return;
    }
    const timeoutId = globalThis.setTimeout(
      () => setAcknowledgementWake((value) => value + 1),
      Math.max(0, acknowledgementDeadline - Date.now() + 25),
    );
    return () => globalThis.clearTimeout(timeoutId);
  }, [acknowledgementDeadline, acknowledgementMessageId, dispatchOwner]);

  useEffect(() => {
    if (dispatchOwner) {
      if (!acknowledgementMessageId || sharedDispatchCount > 0) return;
      const dispatchedEntry = entries.find((entry) => dispatchOwner === `queue:${entry.id}`);
      const acknowledgement = resolveQueuedAcknowledgement({
        phase,
        messageProjected:
          thread?.messages.some((message) => message.id === acknowledgementMessageId) === true,
        previousTurnId,
        latestTurn: thread?.latestTurn ?? null,
        deadlineAt: acknowledgementDeadline,
        now: Date.now(),
      });
      if (acknowledgement === "complete") {
        if (dispatchedEntry) {
          useComposerQueueStore.getState().complete(threadKey, dispatchedEntry.id);
          for (const image of dispatchedEntry.images) revokeBlobPreviewUrl(image.previewUrl);
        }
        useComposerQueueStore.getState().releaseDispatch(threadKey, dispatchOwner);
      } else if (acknowledgement === "expired") {
        if (dispatchedEntry) {
          useComposerQueueStore
            .getState()
            .markFailed(
              threadKey,
              dispatchedEntry.id,
              `The message was accepted but was not confirmed within ${COMPOSER_QUEUE_ACKNOWLEDGEMENT_TIMEOUT_MS / 1_000} seconds. Check the task before retrying.`,
            );
        }
        useComposerQueueStore.getState().releaseDispatch(threadKey, dispatchOwner);
      } else {
        return;
      }
    }

    const next = entries[0];
    if (
      !next ||
      !thread ||
      !canAutoDrainComposerQueue({
        phase,
        isSendBusy: false,
        isConnecting: !isEnvironmentConnected,
        isThreadDetailLoading: threadStatus !== "live",
        hasPendingUserInput,
        awaitingPreviousMessageAcknowledgement: false,
        firstEntryStatus: next.status,
      })
    ) {
      return;
    }

    const nextDispatchOwner = `queue:${next.id}`;
    const queueStore = useComposerQueueStore.getState();
    if (!queueStore.claimDispatch(threadKey, nextDispatchOwner)) return;
    if (!useComposerQueueStore.getState().markDispatching(threadKey, next.id)) {
      useComposerQueueStore.getState().releaseDispatch(threadKey, nextDispatchOwner);
      return;
    }

    void dispatchQueuedComposerEntry({ entry: next, thread }).then(
      (messageId) => {
        useComposerQueueStore
          .getState()
          .acknowledgeDispatch(
            threadKey,
            nextDispatchOwner,
            messageId,
            thread.latestTurn?.turnId ?? null,
          );
      },
      (error: unknown) => {
        useComposerQueueStore
          .getState()
          .markFailed(
            threadKey,
            next.id,
            error instanceof Error ? error.message : "Failed to send queued message.",
          );
        useComposerQueueStore.getState().releaseDispatch(threadKey, nextDispatchOwner);
      },
    );
  }, [
    acknowledgementDeadline,
    acknowledgementMessageId,
    acknowledgementWake,
    dispatchOwner,
    entries,
    hasPendingUserInput,
    phase,
    isEnvironmentConnected,
    previousTurnId,
    sharedDispatchCount,
    thread,
    threadStatus,
    threadKey,
  ]);

  return null;
}

export function QueuedComposerCoordinator() {
  const threadKeys = useComposerQueueStore(
    useShallow((state) => [
      ...new Set([
        ...Object.keys(state.entriesByThreadKey),
        ...Object.keys(state.dispatchOwnerByThreadKey),
      ]),
    ]),
  );
  return threadKeys.map((threadKey) => <QueuedThreadDrain key={threadKey} threadKey={threadKey} />);
}
