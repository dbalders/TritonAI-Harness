import { describe, expect, it } from "@effect/vitest";

import {
  budgetUtilizationTone,
  calculateBudgetUsage,
  formatBudgetDuration,
  formatUsageCurrency,
  formatUsageDate,
  formatUsageLimit,
  formatUsagePercent,
  getUsageViewState,
} from "./UsageSettings.logic";

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
  it("calculates remaining budget and utilization", () => {
    expect(calculateBudgetUsage(3.75, 15)).toEqual({
      remaining: 11.25,
      utilizationPercent: 25,
      meterPercent: 25,
      overBudget: false,
    });
  });

  it("clamps the visual meter while preserving over-budget utilization", () => {
    expect(calculateBudgetUsage(18, 15)).toEqual({
      remaining: 0,
      utilizationPercent: 120,
      meterPercent: 100,
      overBudget: true,
    });
  });

  it("represents an unlimited budget without inventing remaining or percent values", () => {
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

describe("usage formatting", () => {
  it("formats monetary values with useful small-spend precision", () => {
    expect(formatUsageCurrency(0.125)).toContain("0.125");
    expect(formatUsageCurrency(Number.NaN)).toBe("Not available");
  });

  it("formats absent and invalid limits without NaN", () => {
    expect(formatUsagePercent(null)).toBe("Not available");
    expect(formatUsagePercent(Number.NaN)).toBe("Not available");
    expect(formatUsageLimit(null, "requests/min")).toBe("Not reported");
    expect(formatUsageLimit(Number.NaN, "requests/min")).toBe("Not available");
  });

  it("humanizes common budget periods and preserves unknown provider labels", () => {
    expect(formatBudgetDuration("30d")).toBe("30 days");
    expect(formatBudgetDuration("1h")).toBe("1 hour");
    expect(formatBudgetDuration("calendar-month")).toBe("calendar-month");
    expect(formatBudgetDuration(null)).toBe("Not specified");
  });

  it("formats valid dates and rejects invalid provider timestamps", () => {
    expect(
      formatUsageDate("2026-08-01T00:00:00.000Z", {
        locale: "en-US",
        timeZone: "UTC",
      }),
    ).toContain("Aug 1, 2026");
    expect(formatUsageDate("not-a-date")).toBeNull();
    expect(formatUsageDate(null)).toBeNull();
  });

  it("assigns warning and danger tones at meaningful thresholds", () => {
    expect(budgetUtilizationTone(79.9, false)).toBe("default");
    expect(budgetUtilizationTone(80, false)).toBe("warning");
    expect(budgetUtilizationTone(100, false)).toBe("danger");
    expect(budgetUtilizationTone(null, true)).toBe("danger");
  });
});
