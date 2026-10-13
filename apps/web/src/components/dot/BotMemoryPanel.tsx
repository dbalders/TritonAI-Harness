import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import type { DotMemory } from "./dotClient";
import type { DotMemoryInput } from "./dotEnhancements";

export function BotMemoryEditor({
  memory,
  sourceRunId,
  onSave,
  onCancel,
}: {
  readonly memory?: DotMemory | undefined;
  readonly sourceRunId?: string | undefined;
  readonly onSave: (input: DotMemoryInput) => Promise<unknown>;
  readonly onCancel: () => void;
}) {
  const [newId] = useState(randomUUID);
  const [text, setText] = useState(memory?.text ?? "");
  const [kind, setKind] = useState<DotMemoryInput["kind"]>(
    memory?.kind ?? (sourceRunId ? "preference" : "fact"),
  );
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const tooLong = new TextEncoder().encode(text.trim()).byteLength > 2000;
  return (
    <form
      aria-label={memory ? "Correct memory" : "Save preference"}
      className="space-y-3 rounded-lg border p-3 text-sm"
      onSubmit={async (event) => {
        event.preventDefault();
        if (inFlight.current || !reviewed || !text.trim() || tooLong) return;
        inFlight.current = true;
        setBusy(true);
        setError(null);
        try {
          await onSave({
            action: memory ? "edit" : "save-preference",
            ...(memory
              ? { memoryId: memory.memoryId, expectedVersion: memory.version }
              : { memoryId: newId, expectedVersion: 0 }),
            text: text.trim(),
            kind,
            scope: "owner",
            reviewed: true,
            ...(sourceRunId ? { sourceRunId } : {}),
          });
          onCancel();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not save this memory.");
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      }}
    >
      <h3 className="font-semibold">
        {memory ? "Correct saved memory" : "Save a preference from this feedback"}
      </h3>
      <p className="text-xs text-muted-foreground">
        Private to your bot. Ratings alone do not change its instructions. Review the exact wording
        before saving.
      </p>
      {memory ? (
        <label className="block space-y-1">
          Type
          <select
            aria-label="Memory type"
            className="w-full rounded border bg-background p-2"
            value={kind}
            disabled={busy}
            onChange={(event) => {
              setKind(event.target.value as DotMemoryInput["kind"]);
              setReviewed(false);
            }}
          >
            <option value="fact">Fact</option>
            <option value="preference">Preference</option>
            <option value="instruction">Instruction</option>
          </select>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">Type: Preference · Scope: Private to you</p>
      )}
      <label className="block space-y-1">
        What should the bot remember?
        <Textarea
          aria-label="Memory text"
          required
          maxLength={2000}
          value={text}
          disabled={busy}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setReviewed(false);
          }}
        />
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={busy}
          onChange={(event) => setReviewed(event.currentTarget.checked)}
        />{" "}
        I reviewed this wording and want my bot to use it.
      </label>
      {tooLong && (
        <p role="alert" className="text-destructive">
          This memory is too long. Shorten it before saving.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !reviewed || !text.trim() || tooLong}>
          {busy ? "Saving…" : memory ? "Save correction" : "Save preference"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function BotMemoryPanel({
  memories,
  editable,
  disabled,
  onChange,
  onEdit,
  onRead,
  sourceRuns,
  onOpenSource,
}: {
  readonly sourceRuns?: readonly { readonly runId: string; readonly label: string }[] | undefined;
  readonly onOpenSource?: ((runId: string) => void) | undefined;
  readonly memories: readonly DotMemory[];
  readonly editable: boolean;
  readonly disabled: boolean;
  readonly onChange: (memory: DotMemory, action: "complete" | "forget") => Promise<unknown>;
  readonly onEdit: (input: DotMemoryInput) => Promise<unknown>;
  readonly onRead: (memoryId: string) => Promise<{ memory: DotMemory }>;
}) {
  const [editing, setEditing] = useState<DotMemory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const current = editing ? memories.find((item) => item.memoryId === editing.memoryId) : undefined;
  const changed = editing && (!current || current.version > editing.version);
  return (
    <details className="shrink-0 rounded-xl border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">
        Bot memory · {memories.filter((item) => item.status === "active").length} active
      </summary>
      <div className="mt-2 max-h-80 space-y-3 overflow-y-auto text-sm">
        <p className="text-xs text-muted-foreground">
          Ask your bot to remember something or set a reminder. Completed items stop reminders.
          Forget removes the memory; past chat messages remain.
        </p>
        {!memories.length && <p className="text-muted-foreground">Nothing saved yet.</p>}
        {memories.map((item) => (
          <div key={item.memoryId} className="space-y-2 border-t pt-2">
            <p className="whitespace-pre-wrap break-words">{item.text}</p>
            <p className="text-xs text-muted-foreground">
              {item.status === "completed"
                ? "Completed"
                : item.remindAt
                  ? `Reminder: ${new Date(item.remindAt).toLocaleString()}`
                  : "Active context"}
              {item.kind ? ` · ${item.kind}` : ""}
              {item.scope ? " · Private to you" : ""}
            </p>
            {editable && (
              <p className="text-xs text-muted-foreground">
                Source:{" "}
                {item.provenance?.source === "owner"
                  ? "You"
                  : item.provenance?.source === "model"
                    ? "Bot conversation"
                    : item.provenance?.source === "alert"
                      ? "Alert"
                      : item.provenance?.source === "email-follow-up"
                        ? "Email follow-up"
                        : "Not recorded"}
                {item.sourceRunId ? " · From a bot conversation" : ""}
                {item.ownerReviewedAt
                  ? ` · Reviewed ${new Date(item.ownerReviewedAt).toLocaleString()}`
                  : " · Not yet reviewed by you"}
              </p>
            )}
            {editable &&
              item.sourceRunId &&
              onOpenSource &&
              sourceRuns?.some((run) => run.runId === item.sourceRunId) && (
                <Button variant="ghost" size="sm" onClick={() => onOpenSource(item.sourceRunId!)}>
                  View source conversation
                </Button>
              )}
            {editable && Boolean(item.provenance?.observations.length) && (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Source context
                </summary>
                <ul className="list-disc ps-4 text-xs text-muted-foreground">
                  {[...new Set(item.provenance?.observations)].map((observation) => (
                    <li key={observation}>{observation}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex flex-wrap gap-1">
              {editable && item.status === "active" && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled || busy}
                  onClick={async () => {
                    if (inFlight.current) return;
                    inFlight.current = true;
                    setBusy(true);
                    setError(null);
                    setEditing(null);
                    try {
                      const result = await onRead(item.memoryId);
                      setEditing(result.memory);
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : "Could not read this memory.",
                      );
                    } finally {
                      inFlight.current = false;
                      setBusy(false);
                    }
                  }}
                >
                  Edit memory
                </Button>
              )}
              {(item.status === "active"
                ? (["complete", "forget"] as const)
                : (["forget"] as const)
              ).map((action) => (
                <Button
                  key={action}
                  variant="ghost"
                  size="sm"
                  disabled={disabled || busy}
                  onClick={async () => {
                    if (inFlight.current) return;
                    inFlight.current = true;
                    setBusy(true);
                    setError(null);
                    try {
                      await onChange(item, action);
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : "Could not update this memory.",
                      );
                    } finally {
                      inFlight.current = false;
                      setBusy(false);
                    }
                  }}
                >
                  {action === "complete" ? "Done" : "Forget"}
                </Button>
              ))}
            </div>
          </div>
        ))}
        {editing &&
          (changed ? (
            <div role="alert">
              <p>This memory changed. Close this correction and review its latest version.</p>
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Close correction
              </Button>
            </div>
          ) : (
            <BotMemoryEditor
              key={`${editing.memoryId}:${editing.version}`}
              memory={editing}
              onSave={onEdit}
              onCancel={() => setEditing(null)}
            />
          ))}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
