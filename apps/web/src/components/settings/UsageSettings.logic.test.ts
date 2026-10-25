import { formatUsagePercent, formatUsageLimit } from "./UsageSettings.logic";
import { describe, expect, it } from "@effect/vitest";
import { calculateBudgetUsage, getUsageViewState } from "./UsageSettings.logic";

describe("getUsageViewState", () => {
  it("shows loading only while the selected environment query is pending", () => {
    expect(
      getUsageViewState({
        environmentSelected: true,
        hasData: false,
        hasError: false,
        isPending: true,
      }),
    ).toBe("loading");
    expect(
      getUsageViewState({
        environmentSelected: true,
        hasData: false,
        hasError: false,
        isPending: false,
      }),
    ).toBe("unavailable");
  });

  it("keeps stale data visible during refresh errors", () => {
    expect(
      getUsageViewState({
        environmentSelected: true,
        hasData: true,
        hasError: true,
        isPending: false,
      }),
    ).toBe("ready");
  });

  it("distinguishes missing environments and query errors", () => {
    expect(
      getUsageViewState({
        environmentSelected: false,
        hasData: false,
        hasError: false,
        isPending: false,
      }),
    ).toBe("no-environment");
    expect(
      getUsageViewState({
        environmentSelected: true,
        hasData: false,
        hasError: true,
        isPending: false,
      }),
    ).toBe("error");
  });
});

describe("calculateBudgetUsage", () => {
  it("clamps the visual meter while preserving over-budget utilization", () => {
    expect(calculateBudgetUsage(18, 15)).toEqual({
      remaining: 0,
      utilizationPercent: 120,
      meterPercent: 100,
      overBudget: true,
    });
  });

  it("does not invent calculations without a numeric budget", () => {
    expect(calculateBudgetUsage(3.75, null)).toEqual({
      remaining: null,
      utilizationPercent: null,
      meterPercent: null,
      overBudget: false,
    });
  });

  it("does not produce NaN or Infinity for a zero budget", () => {
    expect(calculateBudgetUsage(1, 0)).toEqual({
      remaining: 0,
      utilizationPercent: null,
      meterPercent: 100,
      overBudget: true,
    });
    expect(calculateBudgetUsage(0, 0).meterPercent).toBe(0);
  });

  it("does not turn invalid spend into a real zero-dollar value", () => {
    expect(calculateBudgetUsage(Number.NaN, 15)).toEqual({
      remaining: null,
      utilizationPercent: null,
      meterPercent: null,
      overBudget: false,
    });
  });
});

it("formats absent and invalid limits without NaN", () => {
  expect(formatUsagePercent(null)).toBe("Not available");
  expect(formatUsagePercent(Number.NaN)).toBe("Not available");
  expect(formatUsageLimit(null, "requests/min")).toBe("Not reported");
  expect(formatUsageLimit(Number.NaN, "requests/min")).toBe("Not available");
});
