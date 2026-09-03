import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerQueueStore } from "../../composerQueueStore";
import { derivePendingUserInputs, derivePhase } from "../../session-logic";
import { useThreadDetail } from "../../state/entities";
import { revokeBlobPreviewUrl } from "../ChatView.logic";
import { canAutoDrainComposerQueue, isQueuedMessageTurnComplete } from "./composerDispatch";
import { dispatchQueuedComposerEntry } from "./dispatchQueuedComposerEntry";

function QueuedThreadDrain({ threadKey }: { readonly threadKey: string }) {
  const threadRef = parseScopedThreadKey(threadKey);
  const thread = useThreadDetail(threadRef);
  const entries = useComposerQueueStore((state) => state.entriesByThreadKey[threadKey] ?? []);
  const dispatchOwner = useComposerQueueStore((state) => state.dispatchOwnerByThreadKey[threadKey]);
  const acknowledgementMessageId = useComposerQueueStore(
    (state) => state.dispatchAcknowledgementByThreadKey[threadKey],
  );
  const sharedDispatchCount = useComposerQueueStore(
    (state) => state.sharedDispatchCountByThreadKey[threadKey] ?? 0,
  );
  const phase = derivePhase(thread?.session ?? null);
  const hasPendingUserInput = derivePendingUserInputs(thread?.activities ?? []).length > 0;

  useEffect(() => {
    if (dispatchOwner) {
      if (!acknowledgementMessageId || sharedDispatchCount > 0) return;
      const messageTurnId = thread?.messages.find(
        (message) => message.id === acknowledgementMessageId,
      )?.turnId;
      if (
        phase !== "ready" ||
        !isQueuedMessageTurnComplete({
          messageTurnId,
          latestTurn: thread?.latestTurn ?? null,
        })
      ) {
        return;
      }
      useComposerQueueStore.getState().releaseDispatch(threadKey, dispatchOwner);
    }

    const next = entries[0];
    if (
      !next ||
      !thread ||
      !canAutoDrainComposerQueue({
        phase,
        isSendBusy: false,
        isConnecting: false,
        isThreadDetailLoading: thread === null,
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
          .acknowledgeDispatch(threadKey, nextDispatchOwner, messageId);
        useComposerQueueStore.getState().complete(threadKey, next.id);
        for (const image of next.images) revokeBlobPreviewUrl(image.previewUrl);
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
    acknowledgementMessageId,
    dispatchOwner,
    entries,
    hasPendingUserInput,
    phase,
    sharedDispatchCount,
    thread,
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
