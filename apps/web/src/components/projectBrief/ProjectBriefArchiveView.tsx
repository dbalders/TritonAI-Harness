import type { ProjectBriefArchive, ThreadId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { projectBriefExecutionLabel, projectBriefSafeSourceUrl } from "./projectBriefView";

/** An archive is evidence, not another editable project state. */
export function ProjectBriefArchiveView({
  archive,
  openThread,
}: {
  archive: ProjectBriefArchive;
  openThread: (threadId: ThreadId) => void;
}) {
  const { state } = archive;
  return (
    <div className="space-y-8">
      <p
        role="status"
        className="rounded-lg border border-border bg-muted/20 p-4 text-sm leading-6"
      >
        Saved {new Date(archive.archivedAt).toLocaleString()}. This brief is read-only; its source
        versions, proposals and results are preserved as they were. Unreviewed work has not been
        marked complete.
      </p>
      <section aria-labelledby="archive-summary-title" className="space-y-3">
        <h2 id="archive-summary-title" className="text-sm font-semibold">
          Brief
        </h2>
        {state.brief ? (
          <>
            <p className="whitespace-pre-wrap break-words text-sm leading-7">
              {state.brief.summary}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => state.brief && openThread(state.brief.threadId)}
            >
              Open brief thread
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No brief was published before this archive was saved.
          </p>
        )}
      </section>
      <section aria-labelledby="archive-sources-title" className="space-y-3">
        <h2 id="archive-sources-title" className="text-sm font-semibold">
          Saved source versions
        </h2>
        {state.snapshots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sources were captured.</p>
        ) : (
          <div className="divide-y divide-border">
            {state.snapshots.map((snapshot) => {
              const url = projectBriefSafeSourceUrl(snapshot.url);
              return (
                <details key={snapshot.id} className="py-3">
                  <summary className="cursor-pointer break-words text-sm font-medium">
                    {snapshot.title}
                  </summary>
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Captured {new Date(snapshot.capturedAt).toLocaleString()}
                    </p>
                    <p className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6">
                      {snapshot.text}
                    </p>
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs underline underline-offset-4"
                      >
                        Original source URL
                      </a>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
      {state.proposals.length > 0 ? (
        <section aria-labelledby="archive-proposals-title">
          <h2 id="archive-proposals-title" className="text-sm font-semibold">
            Decisions & next steps
          </h2>
          <div className="divide-y divide-border">
            {state.proposals.map((proposal) => (
              <article key={proposal.id} className="space-y-3 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">
                    {proposal.kind === "decision" ? "Decision" : "Next step"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{proposal.status}</span>
                </div>
                <h3 className="break-words text-base font-medium">{proposal.title}</h3>
                <p className="whitespace-pre-wrap break-words text-sm leading-6">{proposal.body}</p>
                <p className="text-sm leading-6">
                  <span className="font-medium">Done when </span>
                  {proposal.completionCriteria}
                </p>
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    Supporting evidence
                  </summary>
                  <div className="mt-2 space-y-3">
                    {proposal.citations
                      .filter(
                        (citation, index, citations) =>
                          citations.findIndex(
                            (item) =>
                              item.snapshotId === citation.snapshotId &&
                              item.quote === citation.quote,
                          ) === index,
                      )
                      .map((citation) => (
                        <blockquote
                          key={`${citation.snapshotId}:${citation.quote}`}
                          className="border-l-2 border-border pl-3"
                        >
                          <p className="font-medium">
                            {state.snapshots.find((item) => item.id === citation.snapshotId)
                              ?.title ?? "Saved source"}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words leading-5 text-muted-foreground">
                            {citation.quote}
                          </p>
                        </blockquote>
                      ))}
                  </div>
                </details>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      {state.executions.length > 0 ? (
        <section aria-labelledby="archive-results-title">
          <h2 id="archive-results-title" className="text-sm font-semibold">
            Work & returned results
          </h2>
          <div className="divide-y divide-border">
            {state.executions.map((execution) => (
              <article key={execution.id} className="space-y-3 py-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="break-words text-sm font-medium">
                    {state.proposals.find((proposal) => proposal.id === execution.proposalId)
                      ?.title ?? "Project work"}
                  </h3>
                  <Badge variant={execution.status === "completed" ? "success" : "outline"}>
                    {projectBriefExecutionLabel(execution.status)}
                  </Badge>
                </div>
                {execution.result ? (
                  <>
                    <p className="whitespace-pre-wrap break-words text-sm leading-6">
                      {execution.result.summary}
                    </p>
                    {execution.result.artifacts.length > 0 ? (
                      <ul className="space-y-1">
                        {execution.result.artifacts.map((artifact) => (
                          <li key={artifact.relativePath} className="break-all font-mono text-xs">
                            {artifact.relativePath}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">No verified result was returned.</p>
                )}
                <Button size="sm" variant="outline" onClick={() => openThread(execution.threadId)}>
                  Open work thread
                </Button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
