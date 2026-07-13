import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  GaugeIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import type { ServerTritonAiUsageSnapshot } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
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

type UsageTone = "default" | "warning" | "danger";

function statusBadge(usage: ServerTritonAiUsageSnapshot) {
  if (usage.blocked === true) {
    return { label: "Blocked", variant: "destructive" as const, icon: ShieldAlertIcon };
  }
  if (usage.softBudgetCooldown === true) {
    return { label: "Budget cooldown", variant: "warning" as const, icon: Clock3Icon };
  }
  return { label: "No restriction reported", variant: "success" as const, icon: CheckCircle2Icon };
}

function UsageMetric({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: UsageTone;
}) {
  return (
    <div className="min-w-0 bg-card px-4 py-3.5 sm:px-5">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1.5 truncate font-mono text-base font-semibold tabular-nums text-foreground",
          tone === "warning" && "text-warning-foreground",
          tone === "danger" && "text-destructive",
        )}
        title={value}
      >
        {value}
      </dd>
      {detail ? <dd className="mt-1 text-[11px] text-muted-foreground/70">{detail}</dd> : null}
    </div>
  );
}

function BudgetInstrument({ usage }: { usage: ServerTritonAiUsageSnapshot }) {
  const calculation = calculateBudgetUsage(usage.spend, usage.maxBudget);
  const tone = budgetUtilizationTone(calculation.utilizationPercent, calculation.overBudget);
  const utilizationLabel =
    calculation.overBudget && calculation.utilizationPercent === null
      ? "Over limit"
      : formatUsagePercent(calculation.utilizationPercent);
  const meterLabel =
    usage.maxBudget === null
      ? null
      : `${formatUsageCurrency(usage.spend)} used of ${formatUsageCurrency(usage.maxBudget)}${
          calculation.utilizationPercent === null ? "" : ` (${utilizationLabel})`
        }`;

  return (
    <>
      <div className="px-4 py-5 sm:px-5 sm:py-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                Budget utilization
              </h3>
              {calculation.overBudget ? (
                <Badge variant="destructive" size="sm">
                  Over budget
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground/80">
              Current spend against the budget limit reported for this key.
            </p>
          </div>
          <div className="shrink-0 text-left sm:text-right">
            <div
              className={cn(
                "font-mono text-2xl font-semibold tabular-nums tracking-[-0.04em] text-foreground",
                tone === "warning" && "text-warning-foreground",
                tone === "danger" && "text-destructive",
              )}
            >
              {usage.maxBudget === null ? "Not reported" : utilizationLabel}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {calculation.overBudget && usage.maxBudget !== null
                ? `${formatUsageCurrency(usage.spend - usage.maxBudget)} over limit`
                : formatBudgetDuration(usage.budgetDuration)}
            </div>
          </div>
        </div>

        {usage.maxBudget === null ? (
          <div className="mt-5 flex items-start gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-3.5 py-3">
            <GaugeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">No key budget reported</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/80">
                Spend is available, but TritonAI did not report a key-specific maximum. Effective
                limits may still be inherited from another policy.
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-5">
            <div
              className="h-2.5 w-full overflow-hidden rounded-full bg-muted/70 ring-1 ring-border/40 ring-inset"
              role="progressbar"
              aria-label="TritonAI budget utilization"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(calculation.meterPercent ?? 0)}
              aria-valuetext={meterLabel ?? undefined}
            >
              <div
                className={cn(
                  "h-full rounded-full bg-foreground transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none",
                  tone === "warning" && "bg-warning",
                  tone === "danger" && "bg-destructive",
                )}
                style={{ width: `${calculation.meterPercent ?? 0}%` }}
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-4 font-mono text-[10px] tabular-nums text-muted-foreground/70">
              <span>{formatUsageCurrency(usage.spend)} used</span>
              <span>{formatUsageCurrency(usage.maxBudget)} limit</span>
            </div>
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-px border-t border-border/60 bg-border/60 sm:grid-cols-4">
        <UsageMetric label="Used" value={formatUsageCurrency(usage.spend)} detail="USD" />
        <UsageMetric
          label="Budget limit"
          value={usage.maxBudget === null ? "Not reported" : formatUsageCurrency(usage.maxBudget)}
          detail={formatBudgetDuration(usage.budgetDuration)}
        />
        <UsageMetric
          label="Remaining"
          value={
            calculation.remaining === null
              ? "Not available"
              : formatUsageCurrency(calculation.remaining)
          }
          detail={calculation.overBudget ? "Limit exceeded" : "USD"}
          tone={calculation.overBudget ? "danger" : "default"}
        />
        <UsageMetric
          label="Utilization"
          value={utilizationLabel}
          detail={usage.maxBudget === 0 ? "Zero budget limit" : "Current snapshot"}
          tone={tone}
        />
      </dl>
    </>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5">
      <dt className="text-[11px] font-medium text-muted-foreground/80">{label}</dt>
      <dd className="mt-1 break-words text-xs font-medium text-foreground">{value}</dd>
    </div>
  );
}

function UsageDetails({ usage }: { usage: ServerTritonAiUsageSnapshot }) {
  const resetAt =
    usage.budgetResetAt === null
      ? "Not specified"
      : (formatUsageDate(usage.budgetResetAt) ?? "Unavailable");
  const expiresAt =
    usage.expiresAt === null
      ? "Does not expire"
      : (formatUsageDate(usage.expiresAt) ?? "Unavailable");
  const lastActiveAt =
    usage.lastActiveAt === null
      ? "No activity reported"
      : (formatUsageDate(usage.lastActiveAt) ?? "Unavailable");
  const keyLabel = usage.keyAlias ?? usage.keyName ?? "Configured server key";

  return (
    <SettingsSection title="Key & quota details">
      <div className="grid min-w-0 md:grid-cols-2 md:divide-x md:divide-border/60">
        <dl className="min-w-0">
          <DetailItem label="Key" value={keyLabel} />
          {usage.keyAlias && usage.keyName ? (
            <DetailItem label="Masked key name" value={usage.keyName} />
          ) : null}
          <DetailItem label="Budget period" value={formatBudgetDuration(usage.budgetDuration)} />
          <DetailItem label="Budget resets" value={resetAt} />
          <DetailItem label="Key expires" value={expiresAt} />
          <DetailItem label="Last active" value={lastActiveAt} />
        </dl>
        <dl className="min-w-0 border-t border-border/60 md:border-t-0">
          <DetailItem
            label="Tokens per minute"
            value={formatUsageLimit(usage.tpmLimit, "tokens/min")}
          />
          <DetailItem
            label="Requests per minute"
            value={formatUsageLimit(usage.rpmLimit, "requests/min")}
          />
          <DetailItem
            label="Parallel requests"
            value={formatUsageLimit(usage.maxParallelRequests, "concurrent")}
          />
          <div className="min-w-0 border-t border-border/60 px-4 py-3 sm:px-5">
            <dt className="text-[11px] font-medium text-muted-foreground/80">Available models</dt>
            <dd className="mt-2 flex flex-wrap gap-1.5">
              {usage.models.length > 0 ? (
                usage.models.map((model) => (
                  <Badge key={model} variant="outline" size="sm" className="max-w-full">
                    <span className="truncate">{model}</span>
                  </Badge>
                ))
              ) : (
                <span className="text-xs font-medium text-foreground">Not specified</span>
              )}
            </dd>
          </div>
        </dl>
      </div>
    </SettingsSection>
  );
}

function UsageLoadingState() {
  return (
    <div
      className="px-4 py-5 sm:px-5 sm:py-6"
      role="status"
      aria-live="polite"
      aria-label="Loading TritonAI usage"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
        <Skeleton className="h-8 w-20" />
      </div>
      <Skeleton className="mt-6 h-2.5 w-full rounded-full" />
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

function UsageEmptyState({
  title,
  message,
  canRefresh,
  isPending,
  onRefresh,
}: {
  title: string;
  message: string;
  canRefresh: boolean;
  isPending: boolean;
  onRefresh: () => void;
}) {
  return (
    <div
      className="flex flex-col items-start gap-4 px-4 py-8 sm:flex-row sm:items-center sm:px-5"
      role={canRefresh ? "alert" : "status"}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/8 text-destructive">
        <AlertTriangleIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground/80">{message}</p>
      </div>
      {canRefresh ? (
        <Button size="sm" variant="outline" disabled={isPending} onClick={onRefresh}>
          <RefreshCwIcon className={cn(isPending && "animate-spin motion-reduce:animate-none")} />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function UsageSettingsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.tritonAiUsage({ environmentId, input: {} }),
  );
  const viewState = getUsageViewState({
    environmentSelected: environmentId !== null,
    hasData: data !== null,
    hasError: error !== null,
    isPending,
  });
  const missingKey = error?.includes("TRITONAI_API_KEY") ?? false;
  const badge = data ? statusBadge(data) : null;
  const BadgeIcon = badge?.icon;
  const fetchedAt = data ? formatUsageDate(data.fetchedAt) : null;

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Usage snapshot"
        aria-busy={isPending}
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            disabled={environmentId === null || isPending || viewState === "unavailable"}
            onClick={refresh}
          >
            <RefreshCwIcon className={cn(isPending && "animate-spin motion-reduce:animate-none")} />
            Refresh
          </Button>
        }
      >
        {viewState === "loading" ? <UsageLoadingState /> : null}
        {viewState === "no-environment" ? (
          <UsageEmptyState
            title="No server environment selected"
            message="Connect to a TritonAI Harness server to load usage for its configured key."
            canRefresh={false}
            isPending={false}
            onRefresh={refresh}
          />
        ) : null}
        {viewState === "unavailable" ? (
          <UsageEmptyState
            title="Server environment unavailable"
            message="Reconnect the selected TritonAI Harness server to load usage for its configured key."
            canRefresh={false}
            isPending={false}
            onRefresh={refresh}
          />
        ) : null}
        {viewState === "error" && error ? (
          <UsageEmptyState
            title={missingKey ? "API key not configured" : "Usage could not be loaded"}
            message={error}
            canRefresh
            isPending={isPending}
            onRefresh={refresh}
          />
        ) : null}
        {data ? (
          <div aria-live="polite">
            <div className="flex flex-col gap-2 border-b border-border/60 bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate text-xs font-medium text-foreground">
                  {data.keyAlias ?? data.keyName ?? "Configured server key"}
                </span>
                {badge && BadgeIcon ? (
                  <Badge variant={badge.variant} size="sm">
                    <BadgeIcon />
                    {badge.label}
                  </Badge>
                ) : null}
              </div>
              <span className="text-[11px] text-muted-foreground">
                {fetchedAt ? `Updated ${fetchedAt}` : "Update time unavailable"}
              </span>
            </div>
            {error ? (
              <div className="flex items-start gap-2 border-b border-warning/30 bg-warning/5 px-4 py-2.5 text-xs text-warning-foreground sm:px-5">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{error} Showing the last successful snapshot.</span>
              </div>
            ) : null}
            {data.blocked === true || data.softBudgetCooldown === true ? (
              <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs text-destructive">
                <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {data.blocked === true
                    ? "TritonAI reports that this key is blocked. Requests may fail until the restriction is removed."
                    : "TritonAI reports that this key is in budget cooldown. Requests may be temporarily limited."}
                </span>
              </div>
            ) : null}
            <BudgetInstrument usage={data} />
          </div>
        ) : null}
        <div className="border-t border-border/60 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground/70 sm:px-5">
          This is a live quota snapshot from TritonAI, not a usage history. The API key remains on
          the server.
        </div>
      </SettingsSection>

      {data ? <UsageDetails usage={data} /> : null}
    </SettingsPageContainer>
  );
}
