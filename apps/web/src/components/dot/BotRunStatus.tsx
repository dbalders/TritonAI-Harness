import { EllipsisIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { BotWaitingStatus } from "./BotWaitingStatus";
import type { DotRun } from "./dotClient";
import { usableWaiting, type DotWaitingStatus } from "./dotWaiting";

const ACTIVITY_STALE_MS = 90_000;

/** A quiet typing cue: phase changes provide feedback without an endless animation. */
export function BotWorkingIndicator({ phrase }: { readonly phrase: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <span aria-hidden="true" className="rounded-full bg-muted px-2 py-0.5">
        <EllipsisIcon className="size-5" />
      </span>
      <span>{phrase}</span>
    </p>
  );
}

export function botRunStatus(
  run: DotRun,
  elapsedNow = run.progressClock ? performance.now() : Date.now(),
): { phrase: string; expiresAt?: number; waiting?: DotWaitingStatus } | null {
  const now = run.progressClock
    ? run.progressClock.serverAt + Math.max(0, elapsedNow - run.progressClock.receivedAt)
    : elapsedNow;
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
  const localExpiry = run.progressClock
    ? run.progressClock.receivedAt + (expiresAt - run.progressClock.serverAt)
    : expiresAt;
  return { phrase: activity.phrase, expiresAt: localExpiry };
}

/** A single expiry wakeup prevents stale status surviving a stopped/offline poller. */
export function BotRunStatus({ run }: { readonly run: DotRun }) {
  return (
    <BotRunStatusSnapshot
      key={`${run.runId}:${run.status}:${run.progressClock?.receivedAt ?? run.activity?.updatedAt ?? "unknown"}`}
      run={run}
    />
  );
}

function botStatusClock(monotonic: boolean) {
  return monotonic ? performance.now() : Date.now();
}

function BotRunStatusSnapshot({ run }: { readonly run: DotRun }) {
  const monotonic = run.progressClock !== undefined;
  const [clock, setClock] = useState(() => botStatusClock(monotonic));
  const status = botRunStatus(run, clock);
  const expiresAt = status?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setTimeout(
      () => setClock(botStatusClock(monotonic)),
      Math.max(0, expiresAt - botStatusClock(monotonic)),
    );
    const refresh = () => setClock(botStatusClock(monotonic));
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [expiresAt, monotonic]);
  if (status?.waiting)
    return (
      <div className="mt-2">
        <BotWaitingStatus waiting={status.waiting} subject="this message" />
      </div>
    );
  if (status?.expiresAt !== undefined) return <BotWorkingIndicator phrase={status.phrase} />;
  return status ? (
    <p role="status" className="text-sm text-muted-foreground">
      {status.phrase}
    </p>
  ) : null;
}
