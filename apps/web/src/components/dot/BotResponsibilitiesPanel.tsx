import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import type { DotTask } from "./dotClient";
import type { DotResponsibility, DotResponsibilityInput } from "./dotEnhancements";

const STATUS: Record<DotResponsibility["status"], string> = {
  active: "Following",
  snoozed: "Snoozed",
  "needs-decision": "Needs your decision",
  "needs-review": "Review the result",
  completed: "Reviewed and completed",
  cancelled: "Cancelled",
};

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
  onAction,
  onEdit,
  onOpen,
  onLoadTask,
}: {
  readonly item: DotResponsibility;
  readonly task: DotTask | undefined;
  readonly onAction: (input: DotResponsibilityInput) => Promise<unknown>;
  readonly onEdit: () => void;
  readonly onOpen: (taskId: string) => void;
  readonly onLoadTask: (taskId: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  async function act(action: "cancel" | "resume" | "snooze" | "complete") {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const common = { responsibilityId: item.responsibilityId, expectedVersion: item.version };
      await onAction(
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
      );
      setReviewed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update this responsibility.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const terminal = ["cancelled", "completed"].includes(item.status);
  const evidenceMatchesTask =
    task !== undefined &&
    item.sourceEvidence !== undefined &&
    task.updatedAt === item.sourceEvidence.updatedAt &&
    task.status === item.sourceEvidence.status;
  const needsEvidence = !task || (item.sourceEvidence !== undefined && !evidenceMatchesTask);
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
      <p className="text-xs text-muted-foreground">
        Allowed: observe task and notify you.
        {item.nextWakeAt ? ` Next check: ${new Date(item.nextWakeAt).toLocaleString()}.` : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        {item.sourceEvidence?.available
          ? `Latest task: ${item.sourceEvidence.status} · ${new Date(item.sourceEvidence.updatedAt).toLocaleString()}`
          : "Task evidence unavailable; completion is unconfirmed."}
      </p>
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
      </div>
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
  onAction,
  onOpen,
  onLoadTask,
}: {
  readonly responsibilities: readonly DotResponsibility[];
  readonly tasks: readonly DotTask[];
  readonly onAction: (input: DotResponsibilityInput) => Promise<unknown>;
  readonly onOpen: (taskId: string) => void;
  readonly onLoadTask: (taskId: string) => Promise<unknown>;
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
              onAction={onAction}
              onEdit={() => setEditing(item)}
              onOpen={onOpen}
              onLoadTask={onLoadTask}
            />
          ))}
        </ul>
      </div>
    </details>
  );
}
