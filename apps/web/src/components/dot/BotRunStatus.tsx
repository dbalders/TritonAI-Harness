import { useEffect, useReducer } from "react";

import type { DotRun } from "./dotClient";

const ACTIVITY_STALE_MS = 90_000;

export function botRunStatus(
  run: DotRun,
  now = Date.now(),
): { phrase: string; expiresAt?: number } | null {
  if (run.status === "waiting-approval") return { phrase: "Needs your input" };
  if (run.status === "queued") return { phrase: "Queued" };
  if (run.status !== "running") return null;
  const activity = run.activity;
  const updatedAt = activity ? Date.parse(activity.updatedAt) : NaN;
  if (
    run.activityFresh !== true ||
    !activity ||
    !Number.isFinite(updatedAt) ||
    updatedAt > now ||
    now - updatedAt > ACTIVITY_STALE_MS ||
    typeof activity.phrase !== "string" ||
    !activity.phrase.trim() ||
    activity.phrase.length > 60 ||
    /[\r\n\t]/.test(activity.phrase)
  )
    return { phrase: "Status unavailable" };
  return { phrase: activity.phrase, expiresAt: updatedAt + ACTIVITY_STALE_MS + 1 };
}

/** A single expiry wakeup prevents stale status surviving a stopped/offline poller. */
export function BotRunStatus({ run }: { readonly run: DotRun }) {
  "use no memo"; // Read the wall clock on expiry wakeups even when run props are unchanged.
  const [, refreshClock] = useReducer((value: number) => value + 1, 0);
  const status = botRunStatus(run);
  const expiresAt = status?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setTimeout(refreshClock, Math.max(0, expiresAt - Date.now()));
    const refresh = () => refreshClock();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [expiresAt]);
  return status ? (
    <p role="status" className="mt-2 text-xs text-muted-foreground">
      {status.phrase}
    </p>
  ) : null;
}
