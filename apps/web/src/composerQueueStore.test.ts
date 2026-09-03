import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useComposerQueueStore, type QueuedComposerEntry } from "./composerQueueStore";

const entry = (id: string): QueuedComposerEntry =>
  ({
    id,
    createdAt: "2026-09-03T00:00:00.000Z",
    prompt: id,
    images: [],
    files: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    selectedProvider: "codex",
    selectedInstanceId: "codex",
    selectedModel: "gpt-5",
    selectedProviderModels: [],
    selectedPromptEffort: null,
    selectedModelSelection: { instanceId: "codex", model: "gpt-5" },
    supportsThreadGoals: false,
    goalArmed: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    status: "queued",
    error: null,
  }) as unknown as QueuedComposerEntry;

describe("composer queue store", () => {
  beforeEach(() => useComposerQueueStore.getState().clearForTests());

  it("keeps FIFO queues isolated by thread", () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("thread:a", entry("one"));
    store.enqueue("thread:a", entry("two"));
    store.enqueue("thread:b", entry("other"));

    expect(
      useComposerQueueStore.getState().entriesByThreadKey["thread:a"]?.map((x) => x.id),
    ).toEqual(["one", "two"]);
    expect(
      useComposerQueueStore.getState().entriesByThreadKey["thread:b"]?.map((x) => x.id),
    ).toEqual(["other"]);
  });

  it("claims an item once and prevents removing an in-flight item", () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("thread:a", entry("one"));
    store.enqueue("thread:a", entry("two"));

    expect(store.markDispatching("thread:a", "one")).toBe(true);
    expect(useComposerQueueStore.getState().markDispatching("thread:a", "one")).toBe(false);
    expect(useComposerQueueStore.getState().markDispatching("thread:a", "two")).toBe(false);
    expect(useComposerQueueStore.getState().remove("thread:a", "one")).toBeNull();
  });

  it("edits a queued prompt and clears its previous failure", () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("thread:a", entry("one"));
    store.markFailed("thread:a", "one", "offline");
    store.updatePrompt("thread:a", "one", "updated prompt");

    expect(useComposerQueueStore.getState().entriesByThreadKey["thread:a"]?.[0]).toMatchObject({
      prompt: "updated prompt",
      status: "queued",
      error: null,
    });
  });

  it("leaves failed items visible for explicit retry", () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("thread:a", entry("one"));
    store.markDispatching("thread:a", "one");
    store.markFailed("thread:a", "one", "offline");

    expect(useComposerQueueStore.getState().entriesByThreadKey["thread:a"]?.[0]).toMatchObject({
      status: "failed",
      error: "offline",
    });
  });

  it("reorders queued items and completes only the selected item", () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("thread:a", entry("one"));
    store.enqueue("thread:a", entry("two"));
    store.move("thread:a", "two", -1);
    store.complete("thread:a", "two");

    expect(
      useComposerQueueStore.getState().entriesByThreadKey["thread:a"]?.map((item) => item.id),
    ).toEqual(["one"]);
  });
});
