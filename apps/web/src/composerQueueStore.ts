import type {
  MessageId,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ServerProvider,
} from "@t3tools/contracts";
import { create } from "zustand";

import type { ComposerFileAttachment, ComposerImageAttachment } from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import type { ElementContextDraft } from "./lib/elementContext";
import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import type { ReviewCommentContext } from "./reviewCommentContext";

export type QueuedComposerStatus = "queued" | "dispatching" | "failed";

/**
 * A client-owned snapshot of one composer submission. File handles and blob
 * preview URLs deliberately stay in memory: serializing them would turn a
 * reliable live-session queue into broken attachments after reload.
 */
export interface QueuedComposerEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly prompt: string;
  readonly images: readonly ComposerImageAttachment[];
  readonly files: readonly ComposerFileAttachment[];
  readonly terminalContexts: readonly TerminalContextDraft[];
  readonly elementContexts: readonly ElementContextDraft[];
  readonly previewAnnotations: readonly PreviewAnnotationPayload[];
  readonly reviewComments: readonly ReviewCommentContext[];
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly selectedModel: string;
  readonly selectedProviderModels: ServerProvider["models"];
  readonly selectedPromptEffort: string | null;
  readonly selectedModelSelection: ModelSelection;
  readonly supportsThreadGoals: boolean;
  readonly goalArmed: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly status: QueuedComposerStatus;
  readonly error: string | null;
}

interface ComposerQueueState {
  readonly entriesByThreadKey: Readonly<Record<string, readonly QueuedComposerEntry[]>>;
  readonly dispatchOwnerByThreadKey: Readonly<Record<string, string>>;
  readonly dispatchAcknowledgementByThreadKey: Readonly<Record<string, MessageId>>;
  readonly sharedDispatchCountByThreadKey: Readonly<Record<string, number>>;
  enqueue: (threadKey: string, entry: QueuedComposerEntry) => void;
  updatePrompt: (threadKey: string, entryId: string, prompt: string) => void;
  remove: (threadKey: string, entryId: string) => QueuedComposerEntry | null;
  move: (threadKey: string, entryId: string, offset: -1 | 1) => void;
  markDispatching: (threadKey: string, entryId: string) => boolean;
  complete: (threadKey: string, entryId: string) => void;
  markFailed: (threadKey: string, entryId: string, error: string) => void;
  claimDispatch: (threadKey: string, ownerId: string) => boolean;
  acknowledgeDispatch: (threadKey: string, ownerId: string, messageId: MessageId) => void;
  beginSharedDispatch: (threadKey: string, ownerId: string) => boolean;
  endSharedDispatch: (threadKey: string, ownerId: string) => void;
  releaseDispatch: (threadKey: string, ownerId: string) => void;
  clearForTests: () => void;
}

function replaceThreadEntries(
  state: ComposerQueueState,
  threadKey: string,
  entries: readonly QueuedComposerEntry[],
) {
  const entriesByThreadKey = { ...state.entriesByThreadKey };
  if (entries.length === 0) delete entriesByThreadKey[threadKey];
  else entriesByThreadKey[threadKey] = entries;
  return { entriesByThreadKey };
}

export const useComposerQueueStore = create<ComposerQueueState>((set, get) => ({
  entriesByThreadKey: {},
  dispatchOwnerByThreadKey: {},
  dispatchAcknowledgementByThreadKey: {},
  sharedDispatchCountByThreadKey: {},
  enqueue: (threadKey, entry) => {
    if (!threadKey) return;
    set((state) =>
      replaceThreadEntries(state, threadKey, [
        ...(state.entriesByThreadKey[threadKey] ?? []),
        entry,
      ]),
    );
  },
  updatePrompt: (threadKey, entryId, prompt) => {
    set((state) =>
      replaceThreadEntries(
        state,
        threadKey,
        (state.entriesByThreadKey[threadKey] ?? []).map((entry) =>
          entry.id === entryId && entry.status !== "dispatching"
            ? { ...entry, prompt, status: "queued", error: null }
            : entry,
        ),
      ),
    );
  },
  remove: (threadKey, entryId) => {
    const entries = get().entriesByThreadKey[threadKey] ?? [];
    const removed = entries.find((entry) => entry.id === entryId) ?? null;
    if (!removed || removed.status === "dispatching") return null;
    set((state) =>
      replaceThreadEntries(
        state,
        threadKey,
        (state.entriesByThreadKey[threadKey] ?? []).filter((entry) => entry.id !== entryId),
      ),
    );
    return removed;
  },
  move: (threadKey, entryId, offset) => {
    set((state) => {
      const entries = [...(state.entriesByThreadKey[threadKey] ?? [])];
      const index = entries.findIndex((entry) => entry.id === entryId);
      const nextIndex = index + offset;
      if (
        index < 0 ||
        nextIndex < 0 ||
        nextIndex >= entries.length ||
        entries[index]?.status === "dispatching"
      ) {
        return state;
      }
      const [entry] = entries.splice(index, 1);
      if (!entry) return state;
      entries.splice(nextIndex, 0, entry);
      return replaceThreadEntries(state, threadKey, entries);
    });
  },
  markDispatching: (threadKey, entryId) => {
    const entries = get().entriesByThreadKey[threadKey] ?? [];
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry || entries.some((candidate) => candidate.status === "dispatching")) return false;
    set((state) =>
      replaceThreadEntries(
        state,
        threadKey,
        (state.entriesByThreadKey[threadKey] ?? []).map((candidate) =>
          candidate.id === entryId
            ? { ...candidate, status: "dispatching", error: null }
            : candidate,
        ),
      ),
    );
    return true;
  },
  complete: (threadKey, entryId) => {
    set((state) =>
      replaceThreadEntries(
        state,
        threadKey,
        (state.entriesByThreadKey[threadKey] ?? []).filter((entry) => entry.id !== entryId),
      ),
    );
  },
  markFailed: (threadKey, entryId, error) => {
    set((state) =>
      replaceThreadEntries(
        state,
        threadKey,
        (state.entriesByThreadKey[threadKey] ?? []).map((entry) =>
          entry.id === entryId ? { ...entry, status: "failed", error } : entry,
        ),
      ),
    );
  },
  claimDispatch: (threadKey, ownerId) => {
    if (get().dispatchOwnerByThreadKey[threadKey] !== undefined) return false;
    set((state) => ({
      dispatchOwnerByThreadKey: { ...state.dispatchOwnerByThreadKey, [threadKey]: ownerId },
    }));
    return true;
  },
  acknowledgeDispatch: (threadKey, ownerId, messageId) => {
    set((state) => {
      if (state.dispatchOwnerByThreadKey[threadKey] !== ownerId) return state;
      return {
        dispatchAcknowledgementByThreadKey: {
          ...state.dispatchAcknowledgementByThreadKey,
          [threadKey]: messageId,
        },
      };
    });
  },
  beginSharedDispatch: (threadKey, ownerId) => {
    if (get().dispatchOwnerByThreadKey[threadKey] !== ownerId) return false;
    set((state) => ({
      sharedDispatchCountByThreadKey: {
        ...state.sharedDispatchCountByThreadKey,
        [threadKey]: (state.sharedDispatchCountByThreadKey[threadKey] ?? 0) + 1,
      },
    }));
    return true;
  },
  endSharedDispatch: (threadKey, ownerId) => {
    set((state) => {
      if (state.dispatchOwnerByThreadKey[threadKey] !== ownerId) return state;
      const sharedDispatchCountByThreadKey = { ...state.sharedDispatchCountByThreadKey };
      const nextCount = (sharedDispatchCountByThreadKey[threadKey] ?? 0) - 1;
      if (nextCount > 0) sharedDispatchCountByThreadKey[threadKey] = nextCount;
      else delete sharedDispatchCountByThreadKey[threadKey];
      return { sharedDispatchCountByThreadKey };
    });
  },
  releaseDispatch: (threadKey, ownerId) => {
    set((state) => {
      if (
        state.dispatchOwnerByThreadKey[threadKey] !== ownerId ||
        (state.sharedDispatchCountByThreadKey[threadKey] ?? 0) > 0
      ) {
        return state;
      }
      const dispatchOwnerByThreadKey = { ...state.dispatchOwnerByThreadKey };
      const dispatchAcknowledgementByThreadKey = {
        ...state.dispatchAcknowledgementByThreadKey,
      };
      delete dispatchOwnerByThreadKey[threadKey];
      delete dispatchAcknowledgementByThreadKey[threadKey];
      return { dispatchOwnerByThreadKey, dispatchAcknowledgementByThreadKey };
    });
  },
  clearForTests: () =>
    set({
      entriesByThreadKey: {},
      dispatchOwnerByThreadKey: {},
      dispatchAcknowledgementByThreadKey: {},
      sharedDispatchCountByThreadKey: {},
    }),
}));
