import { useId, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type {
  DotHandlingItem,
  DotHandlingState,
  DotHandlingStopResult,
  DotHandlingView,
} from "./dotHandling";

const GROUPS = [
  { label: "Needs you", states: ["waiting-for-you", "failed", "uncertain"] },
  { label: "Working", states: ["working", "waiting-on-system"] },
  { label: "Scheduled", states: ["scheduled"] },
  { label: "Recently done", states: ["done-unseen"] },
] as const;

const STATE_LABELS: Record<DotHandlingState, string> = {
  working: "Working",
  "waiting-for-you": "Waiting for you",
  "waiting-on-system": "Waiting on system",
  scheduled: "Scheduled",
  "done-unseen": "Done (new)",
  failed: "Failed",
  uncertain: "Uncertain: check before retrying",
};

const RUNNING_WARNING =
  "Running Harness tasks cannot be recalled from here. This records a stop request; the result may still return.";
const REFRESH_MESSAGE = "Refresh the handling view before trying again.";

function HandlingTime({
  at,
  timezone,
}: {
  readonly at: string | undefined;
  readonly timezone: string;
}) {
  if (!at || !Number.isFinite(Date.parse(at))) {
    return <span aria-label="Time unknown">—</span>;
  }
  let label: string;
  try {
    label = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(at));
  } catch {
    // Preserve the supplied timestamp rather than silently choosing a different timezone.
    label = at;
  }
  return <time dateTime={at}>{label}</time>;
}

function sourceUrl(link: string | undefined): string | undefined {
  if (!link) return undefined;
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function BotHandlingPanel({
  handling,
  onStop,
  onSeen,
}: {
  readonly handling: DotHandlingView | undefined;
  /** Parent refreshes state after the action and rejects API errors (including HTTP 409). */
  readonly onStop: (item: DotHandlingItem) => Promise<DotHandlingStopResult>;
  readonly onSeen?: (through: string) => Promise<unknown>;
}) {
  const headingId = useId();
  const [selected, setSelected] = useState<DotHandlingItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [markingSeen, setMarkingSeen] = useState(false);
  const seenInFlight = useRef(false);
  const [seenError, setSeenError] = useState<string | null>(null);
  const stopping = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!handling) return null;

  const current = selected
    ? handling.items.find((item) => item.kind === selected.kind && item.id === selected.id)
    : undefined;
  const changed = selected !== null && (!current || current.version !== selected.version);
  const cannotStop = selected !== null && !current?.controls.includes("stop");

  async function confirmStop() {
    if (!selected || changed || cannotStop || stopping.current) return;
    stopping.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await onStop(selected);
      if (!result.ok) {
        setError(`${result.message} ${REFRESH_MESSAGE}`);
        return;
      }
      setNotice(
        result.outcome === "stop-requested"
          ? `${result.message} ${RUNNING_WARNING}`
          : result.message,
      );
      setSelected(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not stop this item.";
      setError(
        typeof cause === "object" && cause !== null && "status" in cause && cause.status === 409
          ? `${message} ${REFRESH_MESSAGE}`
          : message,
      );
    } finally {
      stopping.current = false;
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="shrink-0 rounded-xl border p-3 text-sm">
      <div className="mb-3 flex items-center gap-2">
        <h2 id={headingId} className="font-semibold">
          What the bot is handling
        </h2>
        {handling.paused && (
          <Badge variant="warning" size="sm">
            Paused
          </Badge>
        )}
      </div>
      {handling.upNext && (
        <div className="mb-3 space-y-1 rounded-lg bg-muted/40 p-3">
          <h3 className="font-semibold">Up next</h3>
          <p className="wrap-anywhere">
            {handling.upNext.title}: {handling.upNext.what}
          </p>
          <p className="text-xs text-muted-foreground">
            <HandlingTime at={handling.upNext.at} timezone={handling.timezone} />
            {" · "}
            {handling.timezone}
          </p>
        </div>
      )}
      {handling.unavailable.length > 0 && (
        <div className="mb-3 rounded-lg border p-3" role="status">
          <p className="font-medium">Some sources are unavailable</p>
          <p className="text-muted-foreground">
            Their items are unknown, so this view may be incomplete.
          </p>
          <ul className="mt-1 list-inside list-disc">
            {handling.unavailable.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </div>
      )}
      <p role="status" aria-live="polite" className="wrap-anywhere">
        {notice}
      </p>
      {onSeen && handling.items.some((item) => item.state === "done-unseen") && (
        <div className="mb-3 space-y-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={markingSeen || busy}
            onClick={async () => {
              if (seenInFlight.current) return;
              seenInFlight.current = true;
              setMarkingSeen(true);
              setSeenError(null);
              try {
                await onSeen(handling.generatedAt);
                setNotice("Recent results marked seen.");
              } catch (cause) {
                setSeenError(
                  cause instanceof Error ? cause.message : "Could not mark results seen.",
                );
              } finally {
                seenInFlight.current = false;
                setMarkingSeen(false);
              }
            }}
          >
            {markingSeen ? "Marking seen…" : "Mark recent results seen"}
          </Button>
          {seenError && (
            <p role="alert" className="text-sm text-destructive">
              {seenError}
            </p>
          )}
        </div>
      )}
      <div className="space-y-3">
        {GROUPS.map((group, index) => {
          const items = handling.items.filter((item) =>
            group.states.some((state) => state === item.state),
          );
          if (items.length === 0) return null;
          const groupId = `${headingId}-${index}`;
          return (
            <section key={group.label} aria-labelledby={groupId}>
              <h3 id={groupId} className="mb-2 font-semibold">
                {group.label}
              </h3>
              <ul className="divide-y">
                {items.map((item) => {
                  const link = sourceUrl(item.source?.link);
                  return (
                    <li key={`${item.kind}:${item.id}`} className="space-y-1 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 flex-1 wrap-anywhere font-medium">{item.title}</p>
                        <Badge
                          variant={group.label === "Needs you" ? "warning" : "secondary"}
                          size="sm"
                        >
                          {STATE_LABELS[item.state]}
                        </Badge>
                        {item.controls.includes("stop") && (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            aria-label={`Stop ${item.title}`}
                            onClick={() => {
                              setSelected(item);
                              setError(null);
                              setNotice(null);
                            }}
                          >
                            Stop
                          </Button>
                        )}
                      </div>
                      {item.note && (
                        <p className="wrap-anywhere text-muted-foreground">{item.note}</p>
                      )}
                      {item.upNext && (
                        <p className="wrap-anywhere text-muted-foreground">
                          Next: {item.upNext.what}
                          {" · "}
                          <HandlingTime at={item.upNext.at} timezone={handling.timezone} />
                        </p>
                      )}
                      {item.lastActivityAt && (
                        <p className="text-xs text-muted-foreground">
                          Last activity:{" "}
                          <HandlingTime at={item.lastActivityAt} timezone={handling.timezone} />
                        </p>
                      )}
                      {item.source && (
                        <p className="wrap-anywhere text-xs text-muted-foreground">
                          Source:{" "}
                          {link ? (
                            <a
                              href={link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline underline-offset-2"
                            >
                              {item.source.label}
                            </a>
                          ) : (
                            item.source.label
                          )}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {handling.items.length === 0 && (
          <p className="text-muted-foreground">No items reported by available sources.</p>
        )}
      </div>
      <AlertDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !stopping.current) {
            setSelected(null);
            setError(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {selected?.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              {selected?.kind === "harness-assignment" && selected.state === "working"
                ? RUNNING_WARNING
                : "Stop this item using the bot's available control. This does not undo effects or recall requests already sent."}
              {selected?.note && <span className="mt-2 block">{selected.note}</span>}
            </AlertDialogDescription>
            <div aria-busy={busy}>
              {busy && <p role="status">Stopping…</p>}
              {(error || changed || cannotStop) && !busy && (
                <p role="alert" className="wrap-anywhere text-sm text-destructive">
                  {error ?? `This item changed or can no longer be stopped. ${REFRESH_MESSAGE}`}
                </p>
              )}
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || changed || cannotStop}
              onClick={() => void confirmStop()}
            >
              {busy ? "Stopping…" : "Confirm stop"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
