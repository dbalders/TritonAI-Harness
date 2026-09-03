import { describe, expect, it } from "vite-plus/test";

import {
  canAutoDrainComposerQueue,
  resolveComposerDispatchMode,
  resolveQueuedDispatchTarget,
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

describe("resolveQueuedDispatchTarget", () => {
  const send = async () => {};

  it("returns only the dispatch target bound to the routed thread", () => {
    const target = { threadKey: "thread:a", send };

    expect(resolveQueuedDispatchTarget("thread:a", target)).toBe(target);
    expect(resolveQueuedDispatchTarget("thread:b", target)).toBeNull();
    expect(resolveQueuedDispatchTarget("thread:a", null)).toBeNull();
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
