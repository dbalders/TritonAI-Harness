import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { BotWaitingStatus } from "./BotWaitingStatus";
import type { DotRun, DotTask } from "./dotClient";
import { usableWaiting, type DotWaitingAction } from "./dotWaiting";
import type {
  DotHeldReply,
  DotReplyIntent,
  DotResponsibility,
  DotResponsibilityInput,
  DotResponsibilityReply,
} from "./dotEnhancements";

const STATUS: Record<DotResponsibility["status"], string> = {
  active: "Following",
  snoozed: "Snoozed",
  "needs-decision": "Needs your decision",
  "needs-review": "Review the result",
  completed: "Reviewed and completed",
  cancelled: "Cancelled",
};

const INTENT: Record<DotReplyIntent, string> = {
  input: "Supplied input",
  requirement: "Changed a requirement",
  blocker: "Resolved a blocker",
  cancel: "Asked to stop",
  question: "Asked a question",
};
const HELD_REPLY_MS = 7 * 24 * 60 * 60 * 1000;

function replyState(reply: DotResponsibilityReply): string {
  // The service reads the outcome from the reply and its run, so a turn that stopped partway isn't shown as continued.
  if (reply.outcome?.text) return reply.outcome.text;
  if (!reply.handledByRunId) return "Waiting to continue";
  return reply.notContinued ? `Not continued: ${reply.notContinued}` : "Continued";
}

/** Held messages that could belong to this responsibility and have not been used anywhere yet. */
function heldRepliesFor(
  item: DotResponsibility,
  responsibilities: readonly DotResponsibility[],
  runs: readonly DotRun[],
  now = Date.now(),
): Array<{ run: DotRun; held: DotHeldReply }> {
  const used = new Set(
    responsibilities.flatMap((value) => value.replies?.log.map((reply) => reply.sourceId) ?? []),
  );
  return runs.flatMap((run) => {
    const held = run.result?.detail?.replyHeld;
    return held &&
      !used.has(held.sourceId) &&
      now - Date.parse(run.createdAt) < HELD_REPLY_MS &&
      held.candidates.some((candidate) => candidate.responsibilityId === item.responsibilityId)
      ? [{ run, held }]
      : [];
  });
}

function ResponsibilityReplies({
  item,
  held,
  busy,
  onAction,
  onReply,
  onWaitingAction,
}: {
  readonly item: DotResponsibility;
  readonly held: ReadonlyArray<{ run: DotRun; held: DotHeldReply }>;
  readonly busy: boolean;
  /** Resolves false when the change failed; the row shows the error. */
  readonly onAction: (input: DotResponsibilityInput) => Promise<boolean>;
  readonly onReply: () => void;
  /** Opens the run behind an outcome the snapshot couldn't confirm. */
  readonly onWaitingAction?: ((action: DotWaitingAction) => void) | undefined;
}) {
  const [input, setInput] = useState("");
  const replies = item.replies;
  const common = { responsibilityId: item.responsibilityId, expectedVersion: item.version };
  const recent = [...(replies?.log ?? [])].slice(-5).toReversed();
  return (
    <section aria-label={`Replies for ${item.title}`} className="space-y-2 rounded-md border p-2">
      <p className="text-xs text-muted-foreground">
        {replies?.enabled
          ? "Your next useful reply in this conversation continues this responsibility once. Thanks or OK here starts nothing, unrelated messages get an ordinary answer, and a reply never approves an action. Turning replies off, cancelling or reopening keeps assignments drafted from earlier replies from starting."
          : "Replies are off. Your messages do not continue this responsibility."}
      </p>
      {replies?.awaiting && (
        <p role="status" className="text-xs">
          Waiting for your reply: {replies.awaiting.input} · since{" "}
          {new Date(replies.awaiting.since).toLocaleString()}
        </p>
      )}
      {!replies?.awaiting && replies?.received && (
        <p className="text-xs text-muted-foreground">
          Received {replies.received.input} in your reply ·{" "}
          {new Date(replies.received.at).toLocaleString()}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void onAction({ ...common, action: "replies", enabled: !replies?.enabled })
          }
        >
          {replies?.enabled ? "Turn off replies" : "Continue from my replies"}
        </Button>
        {replies?.enabled && (
          <Button size="sm" variant="outline" disabled={busy} onClick={onReply}>
            Reply in chat
          </Button>
        )}
        {replies?.awaiting && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void onAction({ ...common, action: "stop-waiting" })}
          >
            Stop waiting
          </Button>
        )}
      </div>
      {!replies?.awaiting && item.status !== "snoozed" && (
        <form
          aria-label={`Wait for a reply for ${item.title}`}
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!input.trim()) return;
            void onAction({ ...common, action: "wait", input: input.trim() }).then(
              (saved) => saved && setInput(""),
            );
          }}
        >
          <label className="min-w-0 flex-1 space-y-1 text-xs">
            Wait for
            <Input
              nativeInput
              aria-label="Input to wait for"
              placeholder="the signed budget spreadsheet"
              value={input}
              disabled={busy}
              onChange={(event) => setInput(event.currentTarget.value)}
            />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={busy || !input.trim()}>
            Wait for this
          </Button>
        </form>
      )}
      {replies?.enabled &&
        held.map(({ run, held: value }) => (
          <div key={run.runId} className="space-y-1 text-xs">
            <p>
              Your message “{run.event.text}” could fit more than one responsibility, so nothing was
              changed. {value.classification}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onAction({ ...common, action: "use-reply", runId: run.runId })}
            >
              Use that message here
            </Button>
          </div>
        ))}
      {!!replies?.revisions.length && (
        <div className="text-xs">
          <h4 className="font-medium">Your revisions</h4>
          <ul className="space-y-1">
            {replies.revisions.map((revision) => (
              <li key={revision.seq} className="whitespace-pre-wrap break-words">
                {revision.kind === "deadline" ? "Deadline" : "Requirement"} ·{" "}
                {new Date(revision.at).toLocaleString()}: {revision.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!recent.length && (
        <div className="text-xs">
          <h4 className="font-medium">Recent replies</h4>
          <ul className="space-y-1">
            {recent.map((reply) => (
              <li key={reply.seq}>
                {INTENT[reply.intent]} · {new Date(reply.receivedAt).toLocaleString()} ·{" "}
                {replyState(reply)}
                {reply.outcome?.action?.target?.kind === "run" && onWaitingAction && (
                  <Button
                    size="xs"
                    variant="outline"
                    className="ms-2"
                    onClick={() => onWaitingAction(reply.outcome!.action!)}
                  >
                    {reply.outcome.action.label}
                  </Button>
                )}
                <span className="block text-muted-foreground">{reply.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ResponsibilityEditor({
  responsibility,
  tasks,
  onSave,
  onCancel,
}: {
  readonly responsibility?: DotResponsibility | undefined;
  readonly tasks: readonly DotTask[];
  readonly onSave: (input: DotResponsibilityInput) => Promise<unknown>;
  readonly onCancel: () => void;
}) {
  const [newId] = useState(randomUUID);
  const [taskId, setTaskId] = useState(responsibility?.source.taskId ?? tasks[0]?.taskId ?? "");
  const [title, setTitle] = useState(responsibility?.title ?? tasks[0]?.title ?? "");
  const [outcome, setOutcome] = useState(responsibility?.intendedOutcome ?? "");
  const [criteria, setCriteria] = useState(responsibility?.completionCriteria ?? "");
  const [next, setNext] = useState(
    responsibility?.nextAction ??
      "Watch for progress and notify me when a decision or result needs review.",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  return (
    <form
      aria-label="Responsibility editor"
      className="space-y-3 rounded-lg border p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        setError(null);
        try {
          await onSave({
            ...(responsibility
              ? ({
                  action: "update",
                  responsibilityId: responsibility.responsibilityId,
                  expectedVersion: responsibility.version,
                } as const)
              : ({
                  action: "create",
                  responsibilityId: newId,
                  expectedVersion: 0,
                  source: { kind: "harness-task", taskId },
                } as const)),
            title: title.trim(),
            intendedOutcome: outcome.trim(),
            completionCriteria: criteria.trim(),
            nextAction: next.trim(),
          });
          onCancel();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not save this responsibility.");
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      }}
    >
      <h3 className="font-semibold">
        {responsibility ? "Edit responsibility" : "Follow a task through completion"}
      </h3>
      {!responsibility && (
        <label className="block space-y-1">
          Task
          <select
            className="w-full rounded border bg-background p-2"
            aria-label="Task to follow"
            required
            value={taskId}
            disabled={busy}
            onChange={(event) => {
              setTaskId(event.target.value);
              setTitle(tasks.find((task) => task.taskId === event.target.value)?.title ?? "");
            }}
          >
            {tasks.map((task) => (
              <option key={task.taskId} value={task.taskId}>
                {task.title} · {task.status}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block space-y-1">
        Title
        <Input
          nativeInput
          aria-label="Responsibility title"
          required
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
      </label>
      <label className="block space-y-1">
        Intended outcome
        <Textarea
          aria-label="Intended outcome"
          required
          value={outcome}
          disabled={busy}
          onChange={(event) => setOutcome(event.currentTarget.value)}
        />
      </label>
      <label className="block space-y-1">
        What must be true before this is done?
        <Textarea
          aria-label="Completion criteria"
          required
          value={criteria}
          disabled={busy}
          onChange={(event) => setCriteria(event.currentTarget.value)}
        />
      </label>
      <label className="block space-y-1">
        Next step
        <Textarea
          aria-label="Responsibility next step"
          required
          value={next}
          disabled={busy}
          onChange={(event) => setNext(event.currentTarget.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        The bot may observe this task and notify you. It cannot approve actions, send messages on
        your behalf, or declare the outcome verified.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy || !taskId || !title.trim() || !outcome.trim() || !criteria.trim()}
        >
          {busy ? "Saving…" : "Save responsibility"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ResponsibilityRow({
  item,
  task,
  replies,
  held,
  onAction,
  onEdit,
  onOpen,
  onLoadTask,
  onReply,
  onWaitingAction,
}: {
  readonly item: DotResponsibility;
  readonly task: DotTask | undefined;
  readonly replies: boolean;
  readonly held: ReadonlyArray<{ run: DotRun; held: DotHeldReply }>;
  readonly onAction: (input: DotResponsibilityInput) => Promise<unknown>;
  readonly onEdit: () => void;
  readonly onOpen: (taskId: string) => void;
  readonly onLoadTask: (taskId: string) => Promise<unknown>;
  readonly onReply: () => void;
  readonly onWaitingAction?: ((action: DotWaitingAction) => void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function change(input: DotResponsibilityInput) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onAction(input);
      setReviewed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this responsibility.");
      throw cause;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function act(action: "cancel" | "resume" | "snooze" | "complete" | "reopen") {
    const common = { responsibilityId: item.responsibilityId, expectedVersion: item.version };
    await change(
      action === "snooze"
        ? { ...common, action, until: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
        : action === "complete"
          ? {
              ...common,
              action,
              reviewedEvidence: true,
              evidenceDigest: item.sourceEvidence?.digest ?? "",
            }
          : { ...common, action },
    ).catch(() => undefined);
  }
  const terminal = ["cancelled", "completed"].includes(item.status);
  const evidenceMatchesTask =
    task !== undefined &&
    item.sourceEvidence !== undefined &&
    task.updatedAt === item.sourceEvidence.updatedAt &&
    task.status === item.sourceEvidence.status;
  const needsEvidence = !task || (item.sourceEvidence !== undefined && !evidenceMatchesTask);
  const waiting = usableWaiting(item.waiting);
  return (
    <li
      id={`bot-responsibility-${item.responsibilityId}`}
      tabIndex={-1}
      className="space-y-2 border-t pt-3"
    >
      <div className="flex flex-wrap gap-2">
        <h3 className="font-semibold">{item.title}</h3>
        <Badge variant={item.status.startsWith("needs-") ? "warning" : "secondary"} size="sm">
          {STATUS[item.status]}
        </Badge>
      </div>
      <dl className="space-y-2">
        <div>
          <dt className="font-medium">Outcome</dt>
          <dd className="whitespace-pre-wrap break-words">{item.intendedOutcome}</dd>
        </div>
        <div>
          <dt className="font-medium">Next step</dt>
          <dd className="whitespace-pre-wrap break-words">{item.nextAction}</dd>
        </div>
        <div>
          <dt className="font-medium">Completion criteria</dt>
          <dd className="whitespace-pre-wrap break-words">{item.completionCriteria}</dd>
        </div>
      </dl>
      {waiting ? (
        <>
          <BotWaitingStatus
            waiting={waiting}
            subject={item.title}
            onAction={(action) => (action.kind === "reply" ? onReply() : onWaitingAction?.(action))}
            canAct={(action) =>
              action.kind === "reply"
                ? replies && item.replies?.enabled === true
                : onWaitingAction !== undefined
            }
          />
          <p className="text-xs text-muted-foreground">Allowed: observe task and notify you.</p>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Allowed: observe task and notify you.
            {item.nextWakeAt ? ` Next check: ${new Date(item.nextWakeAt).toLocaleString()}.` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {item.sourceEvidence?.available
              ? `Latest task: ${item.sourceEvidence.status} · ${new Date(item.sourceEvidence.updatedAt).toLocaleString()}`
              : "Task evidence unavailable; completion is unconfirmed."}
          </p>
        </>
      )}
      {task && needsEvidence && (
        <p role="status" className="text-xs text-muted-foreground">
          The task evidence changed. Load the latest result before reviewing completion.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {needsEvidence && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              if (inFlight.current) return;
              inFlight.current = true;
              setBusy(true);
              setError(null);
              try {
                await onLoadTask(item.source.taskId);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not load task evidence.");
              } finally {
                inFlight.current = false;
                setBusy(false);
              }
            }}
          >
            {busy ? "Loading task evidence…" : "Load task evidence"}
          </Button>
        )}
        {task && !needsEvidence && (
          <Button size="sm" variant="outline" onClick={() => onOpen(task.taskId)}>
            Review task
          </Button>
        )}
        {!terminal && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
        )}
        {item.status === "snoozed" ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("resume")}>
            Resume following
          </Button>
        ) : (
          !terminal && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("snooze")}>
              Snooze 1 hour
            </Button>
          )
        )}
        {!terminal && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("cancel")}>
            Cancel following
          </Button>
        )}
        {replies && item.status === "cancelled" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("reopen")}>
            Reopen following
          </Button>
        )}
      </div>
      {replies && !terminal && (
        <ResponsibilityReplies
          item={item}
          held={held}
          busy={busy}
          onAction={(input) =>
            change(input).then(
              () => true,
              () => false,
            )
          }
          onReply={onReply}
          onWaitingAction={onWaitingAction}
        />
      )}
      {item.status === "needs-review" &&
        evidenceMatchesTask &&
        task?.status === "completed" &&
        (task?.result || task?.structuredResult?.summary) &&
        item.sourceEvidence?.available && (
          <div className="space-y-2">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={reviewed}
                disabled={busy}
                onChange={(event) => setReviewed(event.target.checked)}
              />{" "}
              I reviewed the result against the completion criteria.
            </label>
            <Button size="sm" disabled={busy || !reviewed} onClick={() => void act("complete")}>
              Mark reviewed and complete
            </Button>
          </div>
        )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

export function BotResponsibilitiesPanel({
  responsibilities,
  tasks,
  replies,
  runs,
  onAction,
  onOpen,
  onLoadTask,
  onReply,
  onWaitingAction,
}: {
  readonly responsibilities: readonly DotResponsibility[];
  readonly tasks: readonly DotTask[];
  /** The service supports continuing responsibilities from owner replies. */
  readonly replies: boolean;
  readonly runs: readonly DotRun[];
  readonly onAction: (input: DotResponsibilityInput) => Promise<unknown>;
  readonly onOpen: (taskId: string) => void;
  readonly onLoadTask: (taskId: string) => Promise<unknown>;
  readonly onReply: (item: DotResponsibility) => void;
  /** Recovery for a waiting status: open the decision or task, resume the bot, or go to task computer settings. */
  readonly onWaitingAction?: ((action: DotWaitingAction) => void) | undefined;
}) {
  const [editing, setEditing] = useState<DotResponsibility | "new" | null>(null);
  const current =
    editing && editing !== "new"
      ? responsibilities.find((item) => item.responsibilityId === editing.responsibilityId)
      : undefined;
  const changed = editing && editing !== "new" && current?.version !== editing.version;
  return (
    <details className="shrink-0 rounded-xl border p-3" id="bot-responsibilities">
      <summary className="cursor-pointer text-sm font-semibold">
        Responsibilities ·{" "}
        {
          responsibilities.filter((item) => !["completed", "cancelled"].includes(item.status))
            .length
        }{" "}
        active
      </summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Keep one outcome in view across task updates. You decide when the evidence satisfies its
          completion criteria.
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={!tasks.length}
          onClick={() => setEditing("new")}
        >
          Follow a task
        </Button>
        {!tasks.length && (
          <p className="text-xs text-muted-foreground">
            Ask your bot to start a Harness task, then follow it here.
          </p>
        )}
        {editing &&
          (changed ? (
            <div role="alert">
              <p>This responsibility changed. Close the editor and review its latest version.</p>
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Close editor
              </Button>
            </div>
          ) : (
            <ResponsibilityEditor
              key={editing === "new" ? "new" : `${editing.responsibilityId}:${editing.version}`}
              responsibility={editing === "new" ? undefined : editing}
              tasks={tasks}
              onSave={onAction}
              onCancel={() => setEditing(null)}
            />
          ))}
        <ul className="space-y-4">
          {responsibilities.map((item) => (
            <ResponsibilityRow
              key={`${item.responsibilityId}:${item.version}:${item.sourceEvidence?.digest ?? ""}`}
              item={item}
              task={tasks.find((task) => task.taskId === item.source.taskId)}
              replies={replies}
              held={replies ? heldRepliesFor(item, responsibilities, runs) : []}
              onAction={onAction}
              onEdit={() => setEditing(item)}
              onOpen={onOpen}
              onLoadTask={onLoadTask}
              onReply={() => onReply(item)}
              onWaitingAction={onWaitingAction}
            />
          ))}
        </ul>
      </div>
    </details>
  );
}
