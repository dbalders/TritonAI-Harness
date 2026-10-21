import { useState } from "react";
import { Button } from "../ui/button";
import type { DotTask } from "./dotClient";

/** Deliverables belong with the reply, even when the underlying task records are hidden. */
export function BotReturnedFiles({
  task,
  onLoad,
  onDownload,
}: {
  readonly task: DotTask | undefined;
  readonly onLoad: () => Promise<unknown>;
  readonly onDownload: (attachmentId: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = [
    ...new Map(
      (task?.structuredResult?.artifacts ?? [])
        .filter((item) => item.attachmentId)
        .map((item) => [item.attachmentId!, item]),
    ).values(),
  ];
  if (task && files.length === 0) return null;

  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this file. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Returned files" className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {task ? (
          files.map((file) => (
            <Button
              key={file.attachmentId}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void perform(() => onDownload(file.attachmentId!))}
            >
              Download {file.label}
            </Button>
          ))
        ) : (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(onLoad)}>
            Load returned files
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
