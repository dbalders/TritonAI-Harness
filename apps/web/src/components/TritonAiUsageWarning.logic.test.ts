import type { ServerTritonAiUsageSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  observeUsageWarning,
  UsageWarningTracker,
  type UsageWarningState,
} from "./TritonAiUsageWarning.logic";

function usage(
  spend: number,
  budget: ServerTritonAiUsageSnapshot["budget"] = { kind: "limited", maxBudget: 100 },
  overrides: Partial<ServerTritonAiUsageSnapshot> = {},
): ServerTritonAiUsageSnapshot {
  return {
    credential: "current",
    keyName: "test-key",
    keyAlias: null,
    spend,
    budget,
    budgetDuration: "30d",
    budgetResetAt: "2026-08-01T00:00:00.000Z",
    models: [],
    tpmLimit: null,
    rpmLimit: null,
    maxParallelRequests: null,
    expiresAt: null,
    lastActiveAt: null,
    softBudgetCooldown: false,
    blocked: false,
    fetchedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

function observe(previous: UsageWarningState | null, snapshot: ServerTritonAiUsageSnapshot) {
  return observeUsageWarning(previous, "primary", snapshot);
}

describe("observeUsageWarning", () => {
  it("warns once at each remaining-budget threshold", () => {
    const healthy = observe(null, usage(75));
    expect(healthy.warning).toBeNull();
    expect(healthy.activeThreshold).toBeNull();

    const low = observe(healthy.state, usage(80));
    expect(low.warning).toEqual({ threshold: 20, remainingPercent: 20 });
    expect(low.activeThreshold).toBe(20);

    const repeatedLow = observe(low.state, usage(85));
    expect(repeatedLow.warning).toBeNull();
    expect(repeatedLow.activeThreshold).toBe(20);

    const critical = observe(repeatedLow.state, usage(90));
    expect(critical.warning).toEqual({ threshold: 10, remainingPercent: 10 });
    expect(critical.activeThreshold).toBe(10);
    expect(observe(critical.state, usage(95)).warning).toBeNull();
  });

  it("shows only the most urgent warning when usage first appears below ten percent", () => {
    const observation = observe(null, usage(95));

    expect(observation.warning).toEqual({ threshold: 10, remainingPercent: 5 });
    expect(observation.state).toMatchObject({
      warnedAt20Percent: true,
      warnedAt10Percent: true,
    });
  });

  it("re-arms after the budget cycle changes or spend decreases", () => {
    const warned = observe(null, usage(85));
    expect(warned.warning?.threshold).toBe(20);

    const nextCycle = observe(
      warned.state,
      usage(85, undefined, { budgetResetAt: "2026-09-01T00:00:00.000Z" }),
    );
    expect(nextCycle.warning?.threshold).toBe(20);

    const resetSpend = observe(nextCycle.state, usage(10));
    expect(resetSpend.warning).toBeNull();
    expect(observe(resetSpend.state, usage(85)).warning?.threshold).toBe(20);
  });

  it("marks a persistent warning inactive after usage recovers", () => {
    const warned = observe(null, usage(85));
    expect(warned.activeThreshold).toBe(20);

    const recovered = observe(warned.state, usage(10));
    expect(recovered).toMatchObject({
      activeThreshold: null,
      warning: null,
    });
  });

  it("keeps environments isolated", () => {
    const firstEnvironment = observe(null, usage(85));

    const secondEnvironment = observeUsageWarning(firstEnvironment.state, "wsl", usage(85));
    expect(secondEnvironment.warning?.threshold).toBe(20);
  });

  it("retains threshold history when the observer remounts", () => {
    const tracker = new UsageWarningTracker();

    expect(tracker.observe("primary", usage(85)).warning?.threshold).toBe(20);
    expect(tracker.observe("primary", usage(85)).warning).toBeNull();
  });

  it("ignores budgets without a meaningful percentage", () => {
    expect(observe(null, usage(5, { kind: "unlimited" }))).toEqual({
      state: null,
      activeThreshold: null,
      warning: null,
    });
    expect(observe(null, usage(5, { kind: "unreported" }))).toEqual({
      state: null,
      activeThreshold: null,
      warning: null,
    });
    expect(observe(null, usage(5, { kind: "limited", maxBudget: 0 }))).toEqual({
      state: null,
      activeThreshold: null,
      warning: null,
    });
  });

  it("clamps over-budget usage to zero percent remaining", () => {
    expect(observe(null, usage(120)).warning).toEqual({
      threshold: 10,
      remainingPercent: 0,
    });
  });
});
