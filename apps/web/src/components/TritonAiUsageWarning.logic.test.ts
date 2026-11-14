import type { ServerTritonAiUsageSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { observeUsageWarning, type UsageWarningState } from "./TritonAiUsageWarning.logic";

function usage(
  spend: number,
  budget: ServerTritonAiUsageSnapshot["budget"] = { kind: "limited", maxBudget: 100 },
  overrides: Partial<ServerTritonAiUsageSnapshot> = {},
): ServerTritonAiUsageSnapshot {
  return {
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
});
