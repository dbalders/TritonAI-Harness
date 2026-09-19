import { beforeEach, describe, expect, it } from "vite-plus/test";
import { MessageId, PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

import { useComposerQueueStore, type QueuedComposerEntry } from "./composerQueueStore";
import { steerQueuedComposerEntry } from "./components/chat/steerQueuedComposerEntry";
import { getQueuedComposerValidationMessage } from "./components/chat/queuedComposerPrompt";

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

  it("reserves edits across turn completion and restores the queue on save or cancel", () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("thread:a", entry("one"));
    expect(store.beginEditing("thread:a", "one")).toBe(true);
    expect(store.markDispatching("thread:a", "one")).toBe(false);
    expect(store.markDispatching("thread:a", "one", "steer")).toBe(false);
    store.updatePrompt("thread:a", "one", "edited");
    expect(useComposerQueueStore.getState().entriesByThreadKey["thread:a"]?.[0]).toMatchObject({
      prompt: "edited",
      status: "queued",
    });
    store.beginEditing("thread:a", "one");
    store.cancelEditing("thread:a", "one");
    expect(store.markDispatching("thread:a", "one")).toBe(true);
  });

  it("prevents duplicate retries while an accepted submission awaits projection", () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("thread:a", entry("one"));
    store.claimDispatch("thread:a", "queue:one");
    store.markDispatching("thread:a", "one");
    store.acknowledgeDispatch("thread:a", "queue:one", MessageId.make("accepted"), null);
    store.markConfirming("thread:a", "one", "Waiting for confirmation");
    expect(store.markDispatching("thread:a", "one", "steer")).toBe(false);
    expect(store.beginEditing("thread:a", "one")).toBe(false);
    expect(store.remove("thread:a", "one")).toBeNull();
    store.updatePrompt("thread:a", "one", "changed");
    expect(useComposerQueueStore.getState().entriesByThreadKey["thread:a"]?.[0]).toMatchObject({
      status: "confirming",
      prompt: "one",
    });
    expect(store.claimDispatch("thread:a", "another")).toBe(false);
    // The original message remains identifiable when its delayed projection arrives.
    expect(useComposerQueueStore.getState().dispatchAcknowledgementByThreadKey["thread:a"]).toBe(
      "accepted",
    );
    store.complete("thread:a", "one");
    store.releaseDispatch("thread:a", "queue:one");
    expect(store.claimDispatch("thread:a", "another")).toBe(true);
  });

  it("retries a failed entry as a normal turn while idle", async () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("thread:a", entry("one"));
    store.markFailed("thread:a", "one", "offline");
    let sent = false;
    await steerQueuedComposerEntry({
      threadKey: "thread:a",
      entryId: "one",
      mode: "turn",
      send: async (queued) => {
        sent = true;
        store.complete("thread:a", queued.id);
      },
    });
    expect(sent).toBe(true);
    expect(useComposerQueueStore.getState().entriesByThreadKey["thread:a"]).toBeUndefined();
  });

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

  it("completes only the selected item without disturbing FIFO order", () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("thread:a", entry("one"));
    store.enqueue("thread:a", entry("two"));
    store.complete("thread:a", "two");

    expect(
      useComposerQueueStore.getState().entriesByThreadKey["thread:a"]?.map((item) => item.id),
    ).toEqual(["one"]);
  });

  it("serializes dispatch work per thread without blocking other threads", () => {
    const store = useComposerQueueStore.getState();

    expect(store.claimDispatch("thread:a", "first")).toBe(true);
    expect(useComposerQueueStore.getState().claimDispatch("thread:a", "second")).toBe(false);
    expect(useComposerQueueStore.getState().claimDispatch("thread:b", "other")).toBe(true);

    useComposerQueueStore
      .getState()
      .acknowledgeDispatch("thread:a", "first", MessageId.make("message-one"), "turn-before");
    expect(useComposerQueueStore.getState().dispatchAcknowledgementByThreadKey["thread:a"]).toBe(
      "message-one",
    );
    expect(
      useComposerQueueStore.getState().dispatchAcknowledgementDeadlineByThreadKey["thread:a"],
    ).toBeGreaterThan(Date.now());
    expect(useComposerQueueStore.getState().dispatchPreviousTurnIdByThreadKey["thread:a"]).toBe(
      "turn-before",
    );

    useComposerQueueStore.getState().releaseDispatch("thread:a", "second");
    expect(useComposerQueueStore.getState().claimDispatch("thread:a", "second")).toBe(false);

    useComposerQueueStore.getState().releaseDispatch("thread:a", "first");
    expect(
      useComposerQueueStore.getState().dispatchAcknowledgementByThreadKey["thread:a"],
    ).toBeUndefined();
    expect(
      useComposerQueueStore.getState().dispatchAcknowledgementDeadlineByThreadKey["thread:a"],
    ).toBeUndefined();
    expect(
      useComposerQueueStore.getState().dispatchPreviousTurnIdByThreadKey["thread:a"],
    ).toBeUndefined();
    expect(useComposerQueueStore.getState().claimDispatch("thread:a", "second")).toBe(true);
  });

  it("retains the queue barrier until shared steers settle", () => {
    const store = useComposerQueueStore.getState();
    expect(store.claimDispatch("thread:a", "queue:one")).toBe(true);
    store.acknowledgeDispatch(
      "thread:a",
      "queue:one",
      MessageId.make("message-one"),
      "turn-before",
    );

    expect(store.beginSharedDispatch("thread:a", "queue:one")).toBe(true);
    expect(store.beginSharedDispatch("thread:a", "wrong-owner")).toBe(false);
    store.acknowledgeDispatch(
      "thread:a",
      "queue:one",
      MessageId.make("steer-message"),
      "turn-current",
    );
    store.releaseDispatch("thread:a", "queue:one");

    expect(useComposerQueueStore.getState().dispatchOwnerByThreadKey["thread:a"]).toBe("queue:one");
    expect(useComposerQueueStore.getState().dispatchAcknowledgementByThreadKey["thread:a"]).toBe(
      "message-one",
    );
    expect(useComposerQueueStore.getState().dispatchPreviousTurnIdByThreadKey["thread:a"]).toBe(
      "turn-before",
    );

    store.endSharedDispatch("thread:a", "queue:one");
    store.releaseDispatch("thread:a", "queue:one");
    expect(useComposerQueueStore.getState().dispatchOwnerByThreadKey["thread:a"]).toBeUndefined();
  });
});

describe("queued submission recovery", () => {
  beforeEach(() => useComposerQueueStore.getState().clearForTests());

  it("steers a second entry while preserving the first queued turn barrier", async () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("a", entry("one"));
    store.enqueue("a", entry("two"));
    store.claimDispatch("a", "queue:one");
    store.markDispatching("a", "one");
    store.acknowledgeDispatch("a", "queue:one", MessageId.make("message-one"), "before");
    const sent: string[] = [];
    await steerQueuedComposerEntry({
      threadKey: "a",
      entryId: "two",
      send: async (item) => {
        sent.push(item.id);
        expect(store.beginSharedDispatch("a", "queue:one")).toBe(true);
        expect(store.markDispatching("a", "one", "steer")).toBe(false);
        store.complete("a", item.id);
        store.endSharedDispatch("a", "queue:one");
      },
    });
    expect(sent).toEqual(["two"]);
    expect(useComposerQueueStore.getState().entriesByThreadKey.a?.map((x) => x.id)).toEqual([
      "one",
    ]);
    expect(useComposerQueueStore.getState().dispatchOwnerByThreadKey.a).toBe("queue:one");
  });

  it("restores a computer-use entry when preflight returns without sending", async () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("a", { ...entry("one"), prompt: "/computer-use inspect the test window" });
    await steerQueuedComposerEntry({ threadKey: "a", entryId: "one", send: async () => {} });
    expect(useComposerQueueStore.getState().entriesByThreadKey.a?.[0]?.status).toBe("failed");
    expect(store.remove("a", "one")?.id).toBe("one");
  });

  it("keeps a rejected edited message visible and recovers after shortening it", () => {
    const store = useComposerQueueStore.getState();
    store.enqueue("a", entry("one"));
    store.updatePrompt("a", "one", "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1));
    expect(useComposerQueueStore.getState().entriesByThreadKey.a?.[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("120,000-character limit"),
    });
    store.updatePrompt("a", "one", "Shortened follow-up");
    expect(useComposerQueueStore.getState().entriesByThreadKey.a?.[0]).toMatchObject({
      status: "queued",
      error: null,
    });
  });

  it("validates the composed review context, not only the visible prompt", () => {
    const item = {
      ...entry("one"),
      reviewComments: [
        {
          id: "review",
          sectionId: "s",
          sectionTitle: "Review",
          filePath: "example.ts",
          startIndex: 0,
          endIndex: 1,
          rangeLabel: "1",
          text: "Fix this",
          diff: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
        },
      ],
    };
    expect(getQueuedComposerValidationMessage(item)).toContain("120,000-character limit");
  });
});
