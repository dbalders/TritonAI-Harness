export interface BudgetUsageCalculation {
  readonly remaining: number | null;
  readonly utilizationPercent: number | null;
  readonly meterPercent: number | null;
  readonly overBudget: boolean;
}

export type UsageViewState = "ready" | "loading" | "no-environment" | "unavailable" | "error";

export function getUsageViewState(input: {
  readonly environmentSelected: boolean;
  readonly hasData: boolean;
  readonly hasError: boolean;
  readonly isPending: boolean;
}): UsageViewState {
  if (input.hasData) return "ready";
  if (!input.environmentSelected) return "no-environment";
  if (input.isPending) return "loading";
  if (input.hasError) return "error";
  return "unavailable";
}

const USD_FORMAT = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const PERCENT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function calculateBudgetUsage(
  spend: number,
  maxBudget: number | null,
): BudgetUsageCalculation {
  if (!Number.isFinite(spend) || spend < 0) {
    return {
      remaining: null,
      utilizationPercent: null,
      meterPercent: null,
      overBudget: false,
    };
  }
  if (maxBudget === null || !Number.isFinite(maxBudget) || maxBudget < 0) {
    return {
      remaining: null,
      utilizationPercent: null,
      meterPercent: null,
      overBudget: false,
    };
  }

  const remaining = Math.max(maxBudget - spend, 0);
  if (maxBudget === 0) {
    return {
      remaining,
      utilizationPercent: null,
      meterPercent: spend > 0 ? 100 : 0,
      overBudget: spend > 0,
    };
  }

  const utilizationPercent = (spend / maxBudget) * 100;
  return {
    remaining,
    utilizationPercent,
    meterPercent: Math.min(Math.max(utilizationPercent, 0), 100),
    overBudget: spend > maxBudget,
  };
}

export function formatUsageCurrency(value: number): string {
  return Number.isFinite(value) && value >= 0 ? USD_FORMAT.format(value) : "Not available";
}

export function formatUsagePercent(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "Not available"
    : `${PERCENT_FORMAT.format(value)}%`;
}

export function formatUsageLimit(value: number | null, suffix: string): string {
  if (value === null) return "Not reported";
  return Number.isFinite(value) && value >= 0
    ? `${NUMBER_FORMAT.format(value)} ${suffix}`
    : "Not available";
}

export function formatBudgetDuration(value: string | null): string {
  if (!value) return "Not specified";
  const match = /^(\d+)\s*([dhm])$/iu.exec(value.trim());
  if (!match) return value;

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const label = unit === "d" ? "day" : unit === "h" ? "hour" : "minute";
  return `${NUMBER_FORMAT.format(amount)} ${label}${amount === 1 ? "" : "s"}`;
}

export function formatUsageDate(
  value: string | null,
  options?: { readonly locale?: string; readonly timeZone?: string },
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(options?.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

export function budgetUtilizationTone(
  utilizationPercent: number | null,
  overBudget: boolean,
): "default" | "warning" | "danger" {
  if (overBudget || (utilizationPercent !== null && utilizationPercent >= 100)) return "danger";
  if (utilizationPercent !== null && utilizationPercent >= 80) return "warning";
  return "default";
}
