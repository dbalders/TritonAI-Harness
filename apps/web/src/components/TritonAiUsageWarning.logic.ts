import type { ServerTritonAiUsageSnapshot } from "@t3tools/contracts";

export type UsageWarningThreshold = 20 | 10;

export interface UsageWarningState {
  readonly cycleKey: string;
  readonly spend: number;
  readonly warnedAt20Percent: boolean;
  readonly warnedAt10Percent: boolean;
}

export interface UsageWarning {
  readonly threshold: UsageWarningThreshold;
  readonly remainingPercent: number;
}

export interface UsageWarningObservation {
  readonly state: UsageWarningState | null;
  readonly activeThreshold: UsageWarningThreshold | null;
  readonly warning: UsageWarning | null;
}

function usageCycleKey(
  environmentId: string,
  usage: ServerTritonAiUsageSnapshot,
  maxBudget: number,
): string {
  return JSON.stringify([
    environmentId,
    usage.keyAlias,
    usage.keyName,
    maxBudget,
    usage.budgetDuration,
    usage.budgetResetAt,
  ]);
}

export function observeUsageWarning(
  previous: UsageWarningState | null,
  environmentId: string,
  usage: ServerTritonAiUsageSnapshot,
): UsageWarningObservation {
  if (usage.budget.kind !== "limited" || usage.budget.maxBudget <= 0) {
    return { state: null, activeThreshold: null, warning: null };
  }

  const maxBudget = usage.budget.maxBudget;
  const cycleKey = usageCycleKey(environmentId, usage, maxBudget);
  const sameCycle =
    previous !== null && previous.cycleKey === cycleKey && usage.spend >= previous.spend;
  let warnedAt20Percent = sameCycle ? previous.warnedAt20Percent : false;
  let warnedAt10Percent = sameCycle ? previous.warnedAt10Percent : false;
  const remainingPercent = Math.max(0, 100 - (usage.spend / maxBudget) * 100);
  const activeThreshold: UsageWarningThreshold | null =
    remainingPercent <= 10 ? 10 : remainingPercent <= 20 ? 20 : null;
  let threshold: UsageWarningThreshold | null = null;

  if (remainingPercent <= 10 && !warnedAt10Percent) {
    threshold = 10;
    warnedAt10Percent = true;
    warnedAt20Percent = true;
  } else if (remainingPercent <= 20 && !warnedAt20Percent) {
    threshold = 20;
    warnedAt20Percent = true;
  }

  return {
    state: {
      cycleKey,
      spend: usage.spend,
      warnedAt20Percent,
      warnedAt10Percent,
    },
    activeThreshold,
    warning: threshold === null ? null : { threshold, remainingPercent },
  };
}
