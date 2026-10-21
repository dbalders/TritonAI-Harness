import { useState } from "react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import type { DotStructuredResult } from "./dotEnhancements";
import { botWebUrl } from "./dotEnhancements";

/** A finished run and evidence of a correct outcome are separate facts. */
export function BotResultCard({
  result,
  fullReply,
  onDownload,
}: {
  readonly result: DotStructuredResult;
  readonly fullReply?: string | undefined;
  readonly onDownload?: (attachmentId: string) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      aria-label="Task result evidence"
      className="mt-3 space-y-3 rounded-lg border p-3 whitespace-normal"
    >
      <div className="flex flex-wrap gap-2">
        <Badge
          variant={result.execution.status === "completed" ? "secondary" : "warning"}
          size="sm"
        >
          {result.execution.status === "completed" ? "Execution finished" : "Execution failed"}
        </Badge>
        <Badge variant="warning" size="sm">
          Not independently verified
        </Badge>
      </div>
      <p className="whitespace-pre-wrap break-words">{result.summary}</p>
      {fullReply?.trim() && (
        <details>
          <summary className="cursor-pointer font-medium">Full task reply</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{fullReply}</p>
        </details>
      )}
      {(["artifact", "source"] as const).map((kind) => {
        const entries = [
          ...new Map(
            result.artifacts
              .filter((item) => item.kind === kind)
              .map((item) => [`${item.uri}:${item.label}`, item]),
          ).values(),
        ];
        return (
          entries.length > 0 && (
            <div key={kind}>
              <h3 className="font-semibold">{kind === "artifact" ? "Artifacts" : "Sources"}</h3>
              <ul className="list-disc space-y-1 ps-5">
                {entries.map((item) => {
                  const href = botWebUrl(item.uri);
                  return (
                    <li key={`${item.uri}:${item.label}`} className="break-words">
                      {item.attachmentId && onDownload ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            setError(null);
                            try {
                              await onDownload(item.attachmentId!);
                            } catch (cause) {
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : "Could not download this file.",
                              );
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Download {item.label}
                        </Button>
                      ) : href ? (
                        <a
                          className="underline underline-offset-2"
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {item.label}
                        </a>
                      ) : (
                        <>
                          <span>{item.label}</span>
                          <p className="text-xs text-muted-foreground">
                            {item.uri} · Open on the task computer
                          </p>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )
        );
      })}
      {result.checks.length > 0 && (
        <div>
          <h3 className="font-semibold">Reported checks</h3>
          <ul className="list-disc space-y-1 ps-5">
            {[
              ...new Map(
                result.checks.map((check) => [`${check.label}:${check.status}`, check]),
              ).values(),
            ].map((check) => (
              <li key={`${check.label}:${check.status}`}>
                {check.label}:{" "}
                {check.status === "reported-pass"
                  ? "reported passed"
                  : check.status === "reported-fail"
                    ? "reported failed"
                    : "not run"}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.blockers.length > 0 && (
        <div>
          <h3 className="font-semibold">Blockers</h3>
          <ul className="list-disc space-y-1 ps-5">
            {[...new Set(result.blockers)].map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Downloadable files are supplied by the task computer. Other artifacts, sources, and checks
        are reported by the task agent. Review the evidence before treating the outcome as verified.
      </p>
    </section>
  );
}
