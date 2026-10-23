import { act, render as renderTest, type Screen } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { BotRunStatus, botRunStatus } from "./BotRunStatus";
import { observeBotRun, type DotRun } from "./dotClient";

const now = Date.parse("2026-10-08T12:00:00Z");
function running(age = 0): DotRun {
  return {
    runId: "run-1",
    threadId: "dot",
    event: { kind: "message", text: "Hello" },
    status: "running",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    activityFresh: true,
    activity: {
      kind: "calendar",
      phrase: "Checking your calendar",
      startedAt: new Date(now - age).toISOString(),
      updatedAt: new Date(now - age).toISOString(),
      step: 1,
    },
  };
}

describe("run status data", () => {
  it("uses server time and monotonic elapsed time with client clocks hours ahead or behind", () => {
    for (const skew of [-7_200_000, 7_200_000]) {
      const receivedAt = now + skew;
      const run = observeBotRun(running(80_000), new Date(now).toISOString(), receivedAt);
      expect(botRunStatus(run, receivedAt)?.phrase).toBe("Checking your calendar");
      expect(botRunStatus(run, receivedAt)?.expiresAt).toBe(receivedAt + 10_001);
      expect(botRunStatus(run, receivedAt + 10_001)?.phrase).toBe("Status unavailable");
    }
  });

  it("bounds older services to a receipt-relative window without comparing their clock to the client", () => {
    const run = observeBotRun(running(), undefined, 123);
    expect(botRunStatus(run, 124)?.phrase).toBe("Checking your calendar");
    expect(botRunStatus(run, 90_124)?.phrase).toBe("Status unavailable");
    expect(
      botRunStatus(observeBotRun({ ...running(), activityFresh: false }, undefined, 123), 124)
        ?.phrase,
    ).toBe("Status unavailable");
  });

  it("uses only the service phrase and both freshness signals", () => {
    const run = running();
    const { activityFresh: _fresh, ...noFresh } = run;
    const { activity: _activity, ...noActivity } = run;
    expect(botRunStatus(run, now)?.phrase).toBe("Checking your calendar");
    expect(botRunStatus(running(90_001), now)?.phrase).toBe("Status unavailable");
    expect(botRunStatus({ ...run, activityFresh: false }, now)?.phrase).toBe("Status unavailable");
    expect(botRunStatus(noFresh, now)?.phrase).toBe("Status unavailable");
    expect(botRunStatus(noActivity, now)?.phrase).toBe("Status unavailable");
  });

  it("expires progress at the earliest of staleness, the lease end and the service's own change time", () => {
    const run = running();
    expect(botRunStatus({ ...run, leaseExpiresAt: now + 10_000 }, now)?.expiresAt).toBe(
      now + 10_000,
    );
    expect(botRunStatus({ ...run, leaseExpiresAt: now }, now)?.phrase).toBe("Status unavailable");
    const waiting = {
      code: "working",
      on: "bot" as const,
      text: "Checking your calendar.",
      next: [{ kind: "event" as const, what: "Finishes when its current step returns" }],
      changesAt: new Date(now + 5_000).toISOString(),
    };
    expect(botRunStatus({ ...run, leaseExpiresAt: now + 10_000, waiting }, now)?.expiresAt).toBe(
      now + 5_000,
    );
    // A lease longer than the progress window leaves the 90-second staleness as the wake.
    expect(botRunStatus({ ...run, leaseExpiresAt: now + 600_000 }, now)?.expiresAt).toBe(
      now + 90_001,
    );
  });

  it("rejects invalid/future timestamps and unusable phrases without deriving narration", () => {
    const run = running();
    for (const change of [
      { updatedAt: "bad date" },
      { updatedAt: new Date(now + 1).toISOString() },
      { phrase: "x".repeat(61) },
      { phrase: " " },
      { phrase: "two\nlines" },
    ]) {
      expect(botRunStatus({ ...run, activity: { ...run.activity!, ...change } }, now)?.phrase).toBe(
        "Status unavailable",
      );
    }
  });

  it("keeps durable approval waiting independent of expired or missing telemetry", () => {
    const { activity: _activity, ...noActivity } = running();
    expect(
      botRunStatus(
        { ...running(1_000_000), status: "waiting-approval", activityFresh: false },
        now,
      ),
    ).toEqual({ phrase: "Needs your input" });
    expect(botRunStatus({ ...noActivity, status: "waiting-approval" }, now)).toEqual({
      phrase: "Needs your input",
    });
    expect(botRunStatus({ ...running(), status: "queued" }, now)).toEqual({ phrase: "Queued" });
  });

  it.each(["completed", "failed", "uncertain", "cancelled"] as const)(
    "ignores leftover worker activity for %s",
    (status) => {
      expect(botRunStatus({ ...running(), status }, now)).toBeNull();
    },
  );
});

describe("run status expiry without polling", async () => {
  let root: Screen;
  let container: HTMLDivElement;
  async function setupTest() {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(now);
    container = document.createElement("div");
    document.body.append(container);
    root = await renderTest(null, { container, router: false });

    return {
      async [Symbol.asyncDispose]() {
        await act(async () => root.unmount());
        container.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      },
    };
  }

  const render = async (run: DotRun) => {
    await act(async () => root.rerender(<BotRunStatus run={run} />));
  };

  it("expires anchored progress without polling even when wall time jumps", async () => {
    await using _test = await setupTest();
    const run = observeBotRun(running(89_000), new Date(now).toISOString());
    await render(run);
    vi.setSystemTime(now + 7_200_000);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).toBe("Checking your calendar");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_001);
    });
    expect(container.textContent).toBe("Status unavailable");
  });

  it("expires while props and polling remain unchanged, then has no timer", async () => {
    await using _test = await setupTest();
    await render(running(89_000));
    expect(container.textContent).toBe("Checking your calendar");
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(container.textContent).toBe("Status unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces an expiry on new telemetry and clears it on terminal state", async () => {
    await using _test = await setupTest();
    await render(running(89_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const refreshed = {
      ...running(),
      activity: { ...running().activity!, updatedAt: new Date(now + 500).toISOString() },
    };
    await render(refreshed);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(501);
    });
    expect(container.textContent).toBe("Checking your calendar");
    await render({ ...refreshed, status: "completed" });
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops asserting progress at the run's lease end when that comes before the progress goes stale", async () => {
    await using _test = await setupTest();
    // The worker reported progress just now, but its lease ends in 10 seconds; no newer snapshot arrives (an outage).
    await render({ ...running(), leaseExpiresAt: now + 10_000 });
    expect(container.textContent).toBe("Checking your calendar");
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_999);
    });
    expect(container.textContent).toBe("Checking your calendar");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.textContent).toBe("Status unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks the clock on foregrounding after timers were suspended", async () => {
    await using _test = await setupTest();
    await render(running());
    vi.setSystemTime(now + 90_001);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.textContent).toBe("Status unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule durable approval, queued, or already stale status", async () => {
    await using _test = await setupTest();
    for (const run of [
      { ...running(), status: "waiting-approval" as const },
      { ...running(), status: "queued" as const },
      running(90_001),
    ]) {
      await render(run);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("cleans up an outstanding expiry on unmount", async () => {
    await using _test = await setupTest();
    await render(running());
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = await renderTest(null, { container, router: false });
  });
});

describe("run waiting reasons", async () => {
  let root: Screen;
  let container: HTMLDivElement;
  async function setupTest() {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.setSystemTime(now);
    container = document.createElement("div");
    document.body.append(container);
    root = await renderTest(null, { container, router: false });

    return {
      async [Symbol.asyncDispose]() {
        await act(async () => root.unmount());
        container.remove();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      },
    };
  }

  const retryAt = new Date(now + 7 * 60_000).toISOString();
  const deferred = (): DotRun => ({
    ...running(),
    status: "queued",
    waiting: {
      code: "provider-retry",
      on: "bot",
      phase: "deferred",
      text: "Microsoft asked to retry later, so this waits for its retry time.",
      next: [{ kind: "check", at: retryAt, what: "Try again" }],
    },
  });

  it("shows why a queued run waits and its recorded retry time, then marks the retry overdue on one wake", async () => {
    await using _test = await setupTest();
    await act(async () => root.rerender(<BotRunStatus run={deferred()} />));
    expect(container.textContent).toContain("Waiting on the bot");
    expect(container.textContent).toContain("Microsoft asked to retry later");
    expect(container.textContent).toContain("Next check: Try again ·");
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7 * 60_000 + 1);
    });
    expect(container.textContent).toContain("Next check overdue: Try again was due");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an older service's queued run as plain Queued", async () => {
    await using _test = await setupTest();
    const { waiting: _waiting, ...older } = deferred();
    await act(async () => root.rerender(<BotRunStatus run={older} />));
    expect(container.textContent).toBe("Queued");
  });

  it("uses the service's quiet-run reason instead of only 'unavailable', but never over fresh activity", async () => {
    await using _test = await setupTest();
    const quiet: DotRun = {
      ...running(120_000),
      activityFresh: false,
      waiting: {
        code: "no-recent-activity",
        on: "unknown",
        phase: "running",
        text: "No recent progress update. It may still be working; if it stopped, it is marked interrupted after its lease ends.",
        next: [{ kind: "event", what: "Finishes when its current step returns" }],
      },
    };
    await act(async () => root.rerender(<BotRunStatus run={quiet} />));
    expect(container.textContent).toContain("It may still be working");
    await act(async () =>
      root.rerender(<BotRunStatus run={{ ...running(), waiting: quiet.waiting! }} />),
    );
    expect(container.textContent).toBe("Checking your calendar");
  });
});
