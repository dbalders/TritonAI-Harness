import { useComposerQueueStore, type QueuedComposerEntry } from "../../composerQueueStore";

export async function steerQueuedComposerEntry(input: {
  readonly threadKey: string;
  readonly entryId: string;
  readonly mode?: "turn" | "steer";
  readonly send: (entry: QueuedComposerEntry) => Promise<void>;
}): Promise<void> {
  const { threadKey, entryId, send } = input;
  const store = useComposerQueueStore.getState();
  const entry = store.entriesByThreadKey[threadKey]?.find((candidate) => candidate.id === entryId);
  if (!entry || !store.markDispatching(threadKey, entryId, input.mode ?? "steer")) return;
  try {
    await send(entry);
  } catch (error) {
    store.markFailed(
      threadKey,
      entryId,
      error instanceof Error ? error.message : "Failed to steer queued message.",
    );
  } finally {
    // Preflight can return without dispatching (permissions, changed context,
    // unavailable provider). Never leave that entry hidden and unremovable.
    const remaining = useComposerQueueStore
      .getState()
      .entriesByThreadKey[threadKey]?.find((candidate) => candidate.id === entryId);
    if (remaining?.status === "dispatching") {
      store.markFailed(
        threadKey,
        entryId,
        "The message was not sent. Check the task before retrying.",
      );
    }
  }
}
