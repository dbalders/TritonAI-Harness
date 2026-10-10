import { useEffect, useRef, useState } from "react";

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
import type { DotScheduledPrompt, DotScheduledPromptAction, DotWatch } from "./dotRoutines";

export interface BotRoutinesPanelProps {
  readonly watches: readonly DotWatch[] | undefined;
  readonly scheduledPrompts: readonly DotScheduledPrompt[] | undefined;
  /** Return the server acknowledgement after attempting a state refresh; reject request failures. */
  readonly onPromptAction: (
    prompt: DotScheduledPrompt,
    action: DotScheduledPromptAction,
  ) => Promise<unknown>;
}

function timestamp(value: string | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not available";
}

/** One wakeup at the due time also works when the parent's state polling stops. */
function DueNotice({ at, message }: { readonly at: string; readonly message: string }) {
  const [now, setNow] = useState(() => Date.now());
  const dueAt = Date.parse(at);
  useEffect(() => {
    if (!Number.isFinite(dueAt)) return;
    const refreshClock = () => setNow(Date.now());
    const timer =
      dueAt > now
        ? setTimeout(refreshClock, Math.min(2_147_483_647, Math.max(0, dueAt - Date.now())))
        : undefined;
    document.addEventListener("visibilitychange", refreshClock);
    window.addEventListener("focus", refreshClock);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshClock);
      window.removeEventListener("focus", refreshClock);
    };
  }, [dueAt, now]);
  return dueAt <= now ? <p className="text-xs text-muted-foreground">{message}</p> : null;
}

function WatchRow({ watch }: { readonly watch: DotWatch }) {
  const status =
    watch.status === "active"
      ? "Active"
      : watch.status === "paused"
        ? "Paused"
        : watch.status === "expired"
          ? "Expired"
          : "Stopped";
  return (
    <li className="space-y-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="break-words font-medium">{watch.target}</h4>
        <Badge variant="outline">{status}</Badge>
        {watch.lastError && <Badge variant="warning">Check failed</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">
        {watch.watching ?? "GitHub changes"} · {watch.cadence}
      </p>
      <dl className="space-y-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline">Last checked: </dt>
          <dd className="inline">
            {watch.lastCheckedAt ? timestamp(watch.lastCheckedAt) : "Never checked"}
          </dd>
        </div>
        <div>
          <dt className="inline">Last successful check: </dt>
          <dd className="inline">
            {watch.lastSuccessAt ? timestamp(watch.lastSuccessAt) : "No successful check yet"}
          </dd>
        </div>
        <div>
          <dt className="inline">Next check: </dt>
          <dd className="inline">
            {watch.status === "active" ? timestamp(watch.nextCheckAt) : "Not scheduled"}
          </dd>
        </div>
        {watch.lastError && (
          <div>
            <dt className="inline">Last error: </dt>
            <dd className="inline break-words">{watch.lastError}</dd>
          </div>
        )}
      </dl>
      {watch.lastError && (
        <p className="text-xs text-muted-foreground">
          Changes since the last successful check may be missing.
        </p>
      )}
      {watch.status === "active" && watch.nextCheckAt && (
        <DueNotice at={watch.nextCheckAt} message="Check due; no newer check is confirmed." />
      )}
      {watch.delivery === "digest" && (
        <p className="text-xs text-muted-foreground">
          Daily digest{watch.digestTime ? ` at ${watch.digestTime}` : ""}
          {watch.heldForDigest ? ` · ${watch.heldForDigest} changes held` : ""}
        </p>
      )}
      {watch.until && (
        <p className="text-xs text-muted-foreground">Until: {timestamp(watch.until)}</p>
      )}
      {(watch.status === "active" || watch.status === "paused") && (
        <p className="break-words text-xs text-muted-foreground">
          In Teams:{" "}
          <code>
            /watches {watch.status === "active" ? "pause" : "resume"} {watch.watchId}
          </code>{" "}
          or <code>/watches stop {watch.watchId}</code>.
          {watch.status === "paused" &&
            " Resuming starts fresh; changes while paused are not replayed."}
        </p>
      )}
    </li>
  );
}

const OUTCOMES = {
  notable: "Notable result",
  quiet: "Nothing notable",
  "needs-approval": "Needs your approval",
  failed: "Failed; error details are not provided here",
  uncertain: "Outcome uncertain",
  "paused-unread": "Paused after unread results",
} satisfies Record<NonNullable<DotScheduledPrompt["lastRun"]>["outcome"], string>;

function runMessage(response: unknown): string {
  if (
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    response.ok !== true ||
    !("runId" in response) ||
    typeof response.runId !== "string" ||
    !("status" in response)
  ) {
    throw new Error("Run now status is unavailable. Check run history before trying again.");
  }
  const duplicate = "duplicate" in response && response.duplicate === true;
  const prefix = duplicate ? "This request was already received. " : "";
  switch (response.status) {
    case "queued":
      return `${prefix}Run queued; it has not finished.`;
    case "running":
      return `${prefix}Run started; it has not finished.`;
    case "waiting-approval":
      return `${prefix}Run needs your approval.`;
    case "completed":
      return `${prefix}Run completed. Check run history for the result.`;
    case "failed":
      throw new Error(`${prefix}Run failed. Check run history for details.`);
    case "uncertain":
      throw new Error(`${prefix}Run outcome is uncertain. Check run history before trying again.`);
    case "cancelled":
      throw new Error(`${prefix}Run was cancelled.`);
    default:
      throw new Error("Run now status is unavailable. Check run history before trying again.");
  }
}

function PromptRow({
  prompt,
  onPromptAction,
}: {
  readonly prompt: DotScheduledPrompt;
  readonly onPromptAction: BotRoutinesPanelProps["onPromptAction"];
}) {
  const [busy, setBusy] = useState<DotScheduledPromptAction | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const stopButton = useRef<HTMLButtonElement>(null);

  const closeConfirmation = () => {
    setConfirmStop(false);
    stopButton.current?.focus();
  };
  const act = async (action: DotScheduledPromptAction) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setMessage(null);
    setError(null);
    try {
      const response = await onPromptAction(prompt, action);
      if (
        typeof response === "object" &&
        response !== null &&
        "ok" in response &&
        response.ok === false
      ) {
        throw new Error(
          "error" in response && typeof response.error === "string"
            ? response.error
            : "The routine action failed.",
        );
      }
      setMessage(
        action === "run"
          ? runMessage(response)
          : action === "delete"
            ? "Routine stopped. Past results remain in history."
            : action === "pause"
              ? "Pause request accepted."
              : action === "opened"
                ? "Results marked read. A paused routine still needs Resume."
                : "Resume request accepted.",
      );
      if (action === "delete") closeConfirmation();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update this routine. Please try again.",
      );
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  return (
    <li className="space-y-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="break-words font-medium">{prompt.name}</h4>
        <Badge variant="outline">{prompt.enabled ? "Active" : "Paused"}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {prompt.scheduleText} · {prompt.timezone}
      </p>
      <p className="whitespace-pre-wrap break-words">{prompt.prompt}</p>
      <p className="text-xs text-muted-foreground">
        {prompt.notify === "always" ? "Posts every result" : "Posts only notable results"}
      </p>
      {!prompt.enabled && (
        <p className="text-xs text-muted-foreground">
          {prompt.pausedReason === "unread"
            ? "Paused after unread results to limit spending."
            : prompt.pausedReason === "owner"
              ? "Paused by you."
              : "Paused."}{" "}
          No scheduled runs until resumed.
        </p>
      )}
      <dl className="space-y-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline">Last run: </dt>
          <dd className="inline">
            {prompt.lastRun
              ? `${timestamp(prompt.lastRun.at)} · ${OUTCOMES[prompt.lastRun.outcome]}`
              : "Never run"}
          </dd>
        </div>
        <div>
          <dt className="inline">Next run: </dt>
          <dd className="inline">
            {prompt.enabled ? timestamp(prompt.nextRunAt) : "Not scheduled"}
          </dd>
        </div>
      </dl>
      {prompt.enabled && prompt.nextRunAt && (
        <DueNotice at={prompt.nextRunAt} message="Run due; completion is not confirmed." />
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Actions for ${prompt.name}`}>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void act("run")}
        >
          {busy === "run" ? "Requesting run…" : "Run now"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void act(prompt.enabled ? "pause" : "resume")}
        >
          {busy === "pause" || busy === "resume"
            ? "Updating…"
            : prompt.enabled
              ? "Pause"
              : "Resume"}
        </Button>
        {(prompt.lastRun || prompt.consecutiveUnread > 0) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => void act("opened")}
          >
            {busy === "opened" ? "Marking read…" : "Mark results read"}
          </Button>
        )}
        <Button
          ref={stopButton}
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            setError(null);
            setConfirmStop(true);
          }}
        >
          Stop
        </Button>
      </div>
      {prompt.consecutiveUnread > 0 && (
        <p className="text-xs text-muted-foreground">
          {prompt.consecutiveUnread} unread results. After reading them in your conversation, mark
          results read to reset the unread spending limit.
        </p>
      )}
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {error && !confirmStop && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <AlertDialog
        open={confirmStop}
        onOpenChange={(open) => {
          if (!open && !inFlight.current) closeConfirmation();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop “{prompt.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the saved routine and stops future scheduled runs. Past results remain in
              history.
            </AlertDialogDescription>
            {error && (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy !== null} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void act("delete")}
            >
              {busy === "delete" ? "Stopping…" : "Stop routine"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

export function BotRoutinesPanel({
  watches,
  scheduledPrompts,
  onPromptAction,
}: BotRoutinesPanelProps) {
  if (watches === undefined && scheduledPrompts === undefined) return null;
  return (
    <details className="shrink-0 rounded-xl border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">Watches &amp; routines</summary>
      <div className="mt-2 max-h-64 space-y-3 overflow-y-auto text-sm">
        <p className="text-xs text-muted-foreground">
          Times show the last reported state. Active means enabled; it does not confirm a recent
          successful check or run.
        </p>
        {watches !== undefined && (
          <section aria-label="Watches">
            <h3 className="mb-2 text-sm font-semibold">Watches</h3>
            {watches.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No watches yet. Ask your bot in chat to watch a GitHub repository for new releases
                or issues.
              </p>
            ) : (
              <ul className="space-y-3">
                {watches.map((watch) => (
                  <WatchRow key={watch.watchId} watch={watch} />
                ))}
              </ul>
            )}
          </section>
        )}
        {scheduledPrompts !== undefined && (
          <section aria-label="Scheduled prompts">
            <h3 className="mb-2 text-sm font-semibold">Routines</h3>
            {scheduledPrompts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No routines yet. Ask your bot in chat to save a prompt with a schedule, such as a
                weekday inbox check.
              </p>
            ) : (
              <ul className="space-y-3">
                {scheduledPrompts.map((prompt) => (
                  <PromptRow
                    key={prompt.promptId}
                    prompt={prompt}
                    onPromptAction={onPromptAction}
                  />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </details>
  );
}
