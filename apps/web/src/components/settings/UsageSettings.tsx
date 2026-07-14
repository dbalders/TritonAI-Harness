import {
  AlertTriangleIcon,
  Clock3Icon,
  GaugeIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react";
import type { ServerTritonAiUsageSnapshot } from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  budgetUtilizationTone,
  calculateBudgetUsage,
  formatBudgetDuration,
  formatUsageCurrency,
  formatUsageDate,
  formatUsagePercent,
  getUsageViewState,
  usageErrorTitle,
} from "./UsageSettings.logic";

type UsageTone = "default" | "warning" | "danger";

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
  const maxBudget = usage.budget.kind === "limited" ? usage.budget.maxBudget : null;
  const calculation = calculateBudgetUsage(usage.spend, maxBudget);
  const tone = budgetUtilizationTone(calculation.utilizationPercent, calculation.overBudget);
  const budgetResetAt = formatUsageDate(usage.budgetResetAt);
  const budgetResetLabel =
    usage.budgetResetAt === null
      ? "Reset date not specified"
      : budgetResetAt === null
        ? "Reset date unavailable"
        : `Resets ${budgetResetAt}`;
  const utilizationLabel =
    calculation.overBudget && calculation.utilizationPercent === null
      ? "Over limit"
      : formatUsagePercent(calculation.utilizationPercent);
  const utilizationValue =
    usage.budget.kind === "unlimited"
      ? "Not applicable"
      : usage.budget.kind === "unreported"
        ? "Not reported"
        : utilizationLabel;
  const meterLabel =
    maxBudget === null
      ? null
      : `${formatUsageCurrency(usage.spend)} used of ${formatUsageCurrency(maxBudget)}${
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
              Current spend and any key-level budget reported by TritonAI.
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
              {usage.budget.kind === "unlimited"
                ? "No key limit"
                : usage.budget.kind === "unreported"
                  ? "Not reported"
                  : utilizationLabel}
            </div>
            {calculation.overBudget && maxBudget !== null ? (
              <div className="mt-0.5 text-[11px] text-destructive">
                {formatUsageCurrency(usage.spend - maxBudget)} over limit
              </div>
            ) : null}
            <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground sm:justify-end">
              <Clock3Icon className="size-3 shrink-0" aria-hidden />
              <span>{budgetResetLabel}</span>
            </div>
          </div>
        </div>

        {maxBudget === null ? (
          <div className="mt-5 flex items-start gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-3.5 py-3">
            <GaugeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">
                {usage.budget.kind === "unlimited"
                  ? "No key-level budget limit"
                  : "Key budget not reported"}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/80">
                {usage.budget.kind === "unlimited"
                  ? "This key has no direct maximum. Effective limits may still be inherited from another policy."
                  : "TritonAI omitted the key-specific maximum. Effective limits may still be inherited from another policy."}
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
              <span>{formatUsageCurrency(maxBudget)} limit</span>
            </div>
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-px border-t border-border/60 bg-border/60 sm:grid-cols-4">
        <UsageMetric label="Used" value={formatUsageCurrency(usage.spend)} detail="USD" />
        <UsageMetric
          label="Budget limit"
          value={
            usage.budget.kind === "limited"
              ? formatUsageCurrency(usage.budget.maxBudget)
              : usage.budget.kind === "unlimited"
                ? "No key limit"
                : "Not reported"
          }
          detail={formatBudgetDuration(usage.budgetDuration)}
        />
        <UsageMetric
          label="Remaining"
          value={
            calculation.remaining === null
              ? usage.budget.kind === "unlimited"
                ? "No key limit"
                : "Not reported"
              : formatUsageCurrency(calculation.remaining)
          }
          detail={calculation.overBudget ? "Limit exceeded" : "USD"}
          tone={calculation.overBudget ? "danger" : "default"}
        />
        <UsageMetric
          label="Utilization"
          value={utilizationValue}
          detail={
            maxBudget === 0
              ? "Zero budget limit"
              : usage.budget.kind === "unlimited"
                ? "No key-level limit"
                : usage.budget.kind === "unreported"
                  ? "Provider omitted limit"
                  : "Current snapshot"
          }
          tone={tone}
        />
      </dl>
    </>
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

function TritonAiApiKeySetting() {
  const desktopBridge = window.desktopBridge;
  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!desktopBridge) return null;

  const replacement = apiKey.trim();
  const saveReplacement = async () => {
    if (replacement.length === 0 || isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const result = await desktopBridge.replaceTritonAiApiKey(replacement);
      if (result.status === "error") {
        setIsSaving(false);
        setSaveError(result.message);
        return;
      }
      setApiKey("");
      window.setTimeout(() => {
        setIsSaving(false);
        setSaveError(
          "The key was saved, but TritonAI Harness did not restart. Restart the app manually to use the new key.",
        );
      }, 5_000);
    } catch (error) {
      setIsSaving(false);
      setSaveError(
        error instanceof Error
          ? `Desktop request failed: ${error.message}`
          : "The desktop request failed with an unknown error.",
      );
    }
  };

  return (
    <SettingsSection title="API key">
      <form
        className="space-y-4 px-4 py-5 sm:px-5"
        onSubmit={(event) => {
          event.preventDefault();
          void saveReplacement();
        }}
      >
        <div>
          <label
            htmlFor="tritonai-api-key-replacement"
            className="text-xs font-medium text-foreground"
          >
            Replace this desktop's TritonAI API key
          </label>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground/80">
            The existing key is never displayed. Saving securely replaces the desktop override and
            restarts TritonAI Harness so future Codex, usage, and voice transcription requests all
            use the new key. Installer updates will not overwrite this choice.
          </p>
        </div>
        <div className="flex max-w-2xl flex-col gap-2 sm:flex-row">
          <Input
            id="tritonai-api-key-replacement"
            type="password"
            maxLength={8_192}
            autoComplete="new-password"
            spellCheck={false}
            value={apiKey}
            placeholder="Enter replacement API key"
            disabled={isSaving}
            onChange={(event) => {
              setApiKey(event.target.value);
              setSaveError(null);
            }}
          />
          <Button type="submit" disabled={replacement.length === 0 || isSaving}>
            {isSaving ? "Saving…" : "Save and Restart"}
          </Button>
        </div>
        {saveError ? (
          <p className="text-xs text-destructive" role="alert">
            {saveError}
          </p>
        ) : null}
      </form>
    </SettingsSection>
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
  const fetchedAt = data ? formatUsageDate(data.fetchedAt) : null;

  return (
    <SettingsPageContainer>
      <TritonAiApiKeySetting />
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
            title={usageErrorTitle(error)}
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
    </SettingsPageContainer>
  );
}
