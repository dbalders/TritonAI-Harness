// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BotRunStatus, botRunStatus } from "./BotRunStatus";
import type { DotRun } from "./dotClient";

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

describe("run status expiry without polling", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const render = async (run: DotRun) => {
    await act(async () => root.render(<BotRunStatus run={run} />));
  };

  it("expires while props and polling remain unchanged, then has no timer", async () => {
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

  it("rechecks the clock on foregrounding after timers were suspended", async () => {
    await render(running());
    vi.setSystemTime(now + 90_001);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.textContent).toBe("Status unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule durable approval, queued, or already stale status", async () => {
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
    await render(running());
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
