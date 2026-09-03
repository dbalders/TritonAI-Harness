import { describe, expect, it } from "vite-plus/test";

import {
  canAutoDrainComposerQueue,
  isQueuedMessageTurnComplete,
  queuedDispatchBlocksComposer,
  resolveQueuedAcknowledgement,
  resolveComposerDispatchMode,
} from "./composerDispatch";

describe("resolveComposerDispatchMode", () => {
  it("keeps idle sends on the normal path", () => {
    expect(
      resolveComposerDispatchMode({
        phase: "ready",
        activeTurnDefault: "queue",
        inverseModifier: true,
      }),
    ).toBe("auto");
  });

  it("uses the configured action while a turn is active", () => {
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        activeTurnDefault: "queue",
        inverseModifier: false,
      }),
    ).toBe("queue");
  });

  it("inverts either active-turn default", () => {
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        activeTurnDefault: "queue",
        inverseModifier: true,
      }),
    ).toBe("steer");
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        activeTurnDefault: "steer",
        inverseModifier: true,
      }),
    ).toBe("queue");
  });
});

describe("isQueuedMessageTurnComplete", () => {
  it("requires the acknowledged message to belong to the finished latest turn", () => {
    expect(
      isQueuedMessageTurnComplete({
        messageTurnId: "turn:one",
        latestTurn: { turnId: "turn:one", state: "completed" },
      }),
    ).toBe(true);
    expect(
      isQueuedMessageTurnComplete({
        messageTurnId: "turn:one",
        latestTurn: { turnId: "turn:one", state: "running" },
      }),
    ).toBe(false);
    expect(
      isQueuedMessageTurnComplete({
        messageTurnId: "turn:one",
        latestTurn: { turnId: "turn:two", state: "completed" },
      }),
    ).toBe(false);
    expect(
      isQueuedMessageTurnComplete({
        messageTurnId: null,
        latestTurn: { turnId: "turn:one", state: "completed" },
      }),
    ).toBe(false);
  });
});

describe("queuedDispatchBlocksComposer", () => {
  it("keeps the acknowledgement barrier without disabling active-turn actions", () => {
    expect(queuedDispatchBlocksComposer({ phase: "ready", dispatchInFlight: true })).toBe(true);
    expect(queuedDispatchBlocksComposer({ phase: "running", dispatchInFlight: true })).toBe(false);
    expect(queuedDispatchBlocksComposer({ phase: "ready", dispatchInFlight: false })).toBe(false);
  });
});

describe("resolveQueuedAcknowledgement", () => {
  it("expires only a missing projection, not a legitimately long running turn", () => {
    expect(
      resolveQueuedAcknowledgement({
        phase: "ready",
        messageTurnId: null,
        latestTurn: null,
        deadlineAt: 100,
        now: 100,
      }),
    ).toBe("expired");
    expect(
      resolveQueuedAcknowledgement({
        phase: "running",
        messageTurnId: "turn:one",
        latestTurn: { turnId: "turn:one", state: "running" },
        deadlineAt: 100,
        now: 1_000,
      }),
    ).toBe("waiting");
  });

  it("completes only the acknowledged terminal turn", () => {
    expect(
      resolveQueuedAcknowledgement({
        phase: "ready",
        messageTurnId: "turn:one",
        latestTurn: { turnId: "turn:one", state: "completed" },
        deadlineAt: 100,
        now: 1_000,
      }),
    ).toBe("complete");
  });
});

describe("canAutoDrainComposerQueue", () => {
  const ready = {
    phase: "ready" as const,
    isSendBusy: false,
    isConnecting: false,
    isThreadDetailLoading: false,
    hasPendingUserInput: false,
    awaitingPreviousMessageAcknowledgement: false,
    firstEntryStatus: "queued" as const,
  };

  it("allows exactly a ready first queued item", () => {
    expect(canAutoDrainComposerQueue(ready)).toBe(true);
    expect(canAutoDrainComposerQueue({ ...ready, firstEntryStatus: "dispatching" })).toBe(false);
    expect(canAutoDrainComposerQueue({ ...ready, firstEntryStatus: "failed" })).toBe(false);
  });

  it("waits for the previous queued turn to be acknowledged before draining again", () => {
    expect(
      canAutoDrainComposerQueue({
        ...ready,
        awaitingPreviousMessageAcknowledgement: true,
      }),
    ).toBe(false);
  });

  it("does not drain through running, reconnecting, busy, loading, or pending-input states", () => {
    expect(canAutoDrainComposerQueue({ ...ready, phase: "running" })).toBe(false);
    expect(canAutoDrainComposerQueue({ ...ready, isConnecting: true })).toBe(false);
    expect(canAutoDrainComposerQueue({ ...ready, isSendBusy: true })).toBe(false);
    expect(canAutoDrainComposerQueue({ ...ready, isThreadDetailLoading: true })).toBe(false);
    expect(canAutoDrainComposerQueue({ ...ready, hasPendingUserInput: true })).toBe(false);
  });
});
