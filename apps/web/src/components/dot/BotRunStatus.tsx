import { useEffect, useReducer } from "react";

import { BotWaitingStatus } from "./BotWaitingStatus";
import type { DotRun } from "./dotClient";
import { usableWaiting, type DotWaitingStatus } from "./dotWaiting";

const ACTIVITY_STALE_MS = 90_000;

export function botRunStatus(
  run: DotRun,
  now = Date.now(),
): { phrase: string; expiresAt?: number; waiting?: DotWaitingStatus } | null {
  if (run.status === "waiting-approval") return { phrase: "Needs your input" };
  // The service says why a queued run waits and when it really tries again; older services only say queued.
  const waiting = usableWaiting(run.waiting);
  if (run.status === "queued")
    return waiting ? { phrase: waiting.text, waiting } : { phrase: "Queued" };
  if (run.status !== "running") return null;
  // A run the service reported quiet or interrupted says so, rather than only "unavailable".
  if (
    waiting &&
    (waiting.code === "no-recent-activity" || waiting.code === "execution-uncertain") &&
    run.activityFresh !== true
  )
    return { phrase: waiting.text, waiting };
  const activity = run.activity;
  const updatedAt = activity ? Date.parse(activity.updatedAt) : NaN;
  // Progress stops being current at whichever comes first: it going stale, the run's lease ending, or the service's
  // own change time. One wake then, so an outage never keeps asserting work past a known end.
  const expiresAt = Math.min(
    updatedAt + ACTIVITY_STALE_MS + 1,
    typeof run.leaseExpiresAt === "number" && Number.isFinite(run.leaseExpiresAt)
      ? run.leaseExpiresAt
      : Infinity,
    Date.parse(waiting?.changesAt ?? "") || Infinity,
  );
  if (
    run.activityFresh !== true ||
    !activity ||
    !Number.isFinite(updatedAt) ||
    updatedAt > now ||
    now >= expiresAt ||
    typeof activity.phrase !== "string" ||
    !activity.phrase.trim() ||
    activity.phrase.length > 60 ||
    /[\r\n\t]/.test(activity.phrase)
  )
    return { phrase: "Status unavailable" };
  return { phrase: activity.phrase, expiresAt };
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
  if (status?.waiting)
    return (
      <div className="mt-2">
        <BotWaitingStatus waiting={status.waiting} subject="this message" />
      </div>
    );
  return status ? (
    <p role="status" className="mt-2 text-xs text-muted-foreground">
      {status.phrase}
    </p>
  ) : null;
}
