import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ProjectNextStep } from "@t3tools/contracts";
import { ArrowRightIcon, CheckIcon, XIcon } from "lucide-react";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import type { ProjectOverviewView } from "./useProjectOverview";

export function ProjectDescription({ view }: { view: ProjectOverviewView }) {
  return (
    <section aria-labelledby="project-about">
      <h2 id="project-about" className="text-sm font-semibold">
        About this project
      </h2>
      {view.snapshot?.overview ? (
        <p className="mt-3 break-words text-sm leading-6 text-foreground/80">
          {view.snapshot.overview.description}
        </p>
      ) : view.busy ? (
        <div className="mt-3 space-y-2" aria-label="Loading project description">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          A short overview will appear here as this project takes shape.
        </p>
      )}
    </section>
  );
}

export function ProjectNextSteps({
  view,
  environmentId,
  connected,
  supported,
  opening,
  onOpen,
}: {
  view: ProjectOverviewView;
  environmentId: EnvironmentId;
  connected: boolean;
  supported: boolean;
  opening: string | null;
  onOpen: (step: ProjectNextStep) => void;
}) {
  const overview = view.snapshot?.overview;
  const loading = connected && supported && (!view.snapshot || view.busy);
  return (
    <section
      aria-labelledby="project-next"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="border-b border-border bg-muted/25 px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <h2 id="project-next" className="text-base font-semibold tracking-tight">
            What’s next
          </h2>
          {view.canRefresh ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={view.busy}
              onClick={() => void view.refresh(true)}
              aria-label="Refresh project next steps"
            >
              <RefreshIcon refreshing={view.busy} />
              Refresh
            </Button>
          ) : null}
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Suggested from this project’s threads. Open a draft to review and send.
        </p>
        <div
          role="status"
          aria-live="polite"
          className="mt-3 flex min-h-5 items-center gap-2 text-xs text-muted-foreground"
        >
          {loading ? (
            <>
              <Spinner size="xs" aria-hidden />
              {overview ? "Updating next steps…" : "Generating next steps…"}
            </>
          ) : overview ? (
            <>
              Saved {formatRelativeTimeLabel(overview.generatedAt)}
              {!connected ? " · offline" : ""}
            </>
          ) : !connected ? (
            "Reconnect to see suggested next steps."
          ) : !supported ? (
            "Update this environment to see suggested next steps."
          ) : null}
        </div>
      </div>
      <div className="px-4 pb-4 sm:px-5">
        {view.error ? (
          <div role="alert" className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <p className="break-words text-muted-foreground">
              {view.error}
              {overview ? " Showing the saved suggestions." : ""}
            </p>
            {view.canRefresh && !view.busy ? (
              <Button size="xs" variant="outline" onClick={() => void view.refresh(true)}>
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}
        {overview?.nextSteps.length ? (
          <ol className="divide-y divide-border">
            {overview.nextSteps.map((step) => (
              <li key={step.id} className="py-4 last:pb-0">
                <h3 className="break-words text-sm font-medium">{step.title}</h3>
                <p className="mt-1.5 break-words text-sm leading-6 text-foreground/75">
                  {step.reason}
                </p>
                <div className="mt-3">
                  <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="shrink-0">From:</span>
                    {overview.sources
                      .filter((source) => step.sources.includes(source.ref))
                      .map((source) =>
                        source.threadId ? (
                          <Link
                            key={source.ref}
                            to="/$environmentId/$threadId"
                            params={{ environmentId, threadId: source.threadId }}
                            className="max-w-full truncate underline decoration-border underline-offset-4 hover:text-foreground"
                          >
                            {source.title}
                          </Link>
                        ) : (
                          <span key={source.ref}>{source.title}</span>
                        ),
                      )}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={!view.canOpen || opening !== null}
                      aria-busy={opening === step.id}
                      onClick={() => onOpen(step)}
                    >
                      {opening === step.id ? <Spinner aria-hidden /> : null}
                      {opening === step.id ? "Opening thread…" : "Open in new thread"}
                      {opening !== step.id ? <ArrowRightIcon aria-hidden /> : null}
                    </Button>
                    {view.canGiveFeedback ? (
                      <>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => void view.dismiss(step, "done")}
                        >
                          <CheckIcon aria-hidden />
                          Already done
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => void view.dismiss(step, "not-relevant")}
                        >
                          <XIcon aria-hidden />
                          Not relevant
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : loading && !overview ? (
          <div className="mt-5 space-y-5" aria-hidden>
            {[0, 1].map((index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ))}
          </div>
        ) : !view.error && connected && supported ? (
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            {overview
              ? "No clear next step in the saved context. Start a thread when you’re ready to move the project forward."
              : view.snapshot?.contextAvailable === false
                ? "Start a thread to give this project context. Next steps will appear here when you return."
                : "Next steps will appear here after the project context is ready."}
          </p>
        ) : null}
        {view.canGiveFeedback && view.snapshot?.dismissedCount ? (
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            {view.snapshot.dismissedCount} hidden{" "}
            {view.snapshot.dismissedCount === 1 ? "suggestion" : "suggestions"}
            <Button variant="link" size="xs" onClick={() => void view.restore()}>
              Restore
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
