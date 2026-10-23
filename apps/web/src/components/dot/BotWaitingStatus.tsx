import { useEffect, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  WAITING_ON_LABELS,
  waitingTimes,
  type DotWaitingAction,
  type DotWaitingStatus,
} from "./dotWaiting";

function WaitingTime({
  at,
  timezone,
}: {
  readonly at: string;
  readonly timezone?: string | undefined;
}) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return <span>an unknown time</span>;
  let label: string;
  try {
    label = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    // Keep the service's timestamp rather than silently choosing another timezone.
    label = at;
  }
  return <time dateTime={at}>{label}</time>;
}

/**
 * Why something is waiting, what would move it, the last update a record confirms and its real next check. A check
 * whose time passes reads as overdue, and a status whose own time-driven change has passed says it may be out of date,
 * through one wake at the next such time rather than a repaint loop.
 */
export function BotWaitingStatus({
  waiting,
  subject,
  timezone,
  onAction,
  canAct,
}: {
  readonly waiting: DotWaitingStatus;
  /** Names the item for assistive technology, such as the responsibility title. */
  readonly subject: string;
  readonly timezone?: string | undefined;
  readonly onAction?: ((action: DotWaitingAction) => void) | undefined;
  readonly canAct?: ((action: DotWaitingAction) => boolean) | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  const { overdue, expired } = waitingTimes(waiting, now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const sampleClock = () => {
      const current = Date.now();
      setNow(current);
      const { wake } = waitingTimes(waiting, current);
      if (wake !== undefined) {
        timer = setTimeout(sampleClock, Math.min(2_147_483_647, Math.max(0, wake - current) + 1));
      }
    };
    timer = setTimeout(sampleClock, 0);
    return () => clearTimeout(timer);
  }, [waiting]);
  const action =
    waiting.action && onAction && (canAct?.(waiting.action) ?? true) ? waiting.action : undefined;
  return (
    <div role="group" aria-label={`Status of ${subject}`} className="space-y-1 text-xs">
      <p className="wrap-anywhere">
        <Badge
          variant={waiting.on === "you" || waiting.on === "connection" ? "warning" : "secondary"}
          size="sm"
        >
          {WAITING_ON_LABELS[waiting.on]}
        </Badge>{" "}
        {waiting.text}
      </p>
      {waiting.notes?.map((note) => (
        <p key={note} className="wrap-anywhere text-muted-foreground">
          {note}
        </p>
      ))}
      {waiting.confirmed && (
        <p className="text-muted-foreground">
          Last confirmed: {waiting.confirmed.what} ·{" "}
          <WaitingTime at={waiting.confirmed.at} timezone={timezone} />
        </p>
      )}
      {waiting.next.map((step, index) => (
        <p key={`${step.kind}:${step.what}`} className="wrap-anywhere text-muted-foreground">
          {step.kind !== "check" ? (
            <>
              {step.kind === "none" ? "Next check: none. " : "Next: "}
              {step.what}
            </>
          ) : overdue[index] ? (
            <>
              Next check overdue: {step.what} was due{" "}
              <WaitingTime at={step.at} timezone={timezone} />
            </>
          ) : (
            <>
              Next check: {step.what} · <WaitingTime at={step.at} timezone={timezone} />
            </>
          )}
        </p>
      ))}
      {waiting.changesAt && expired && (
        <p className="text-muted-foreground">
          This was expected to change at <WaitingTime at={waiting.changesAt} timezone={timezone} />.
          It updates when the bot next reports.
        </p>
      )}
      {action && (
        <Button size="xs" variant="outline" onClick={() => onAction?.(action)}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
