import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ProjectNextStep } from "@t3tools/contracts";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import type { ProjectOverviewView } from "./useProjectOverview";

function ProjectSummary({ text, about = false }: { text: string; about?: boolean }) {
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  // oxlint-disable-next-line t3code/react-effect-budget -- Synchronize the disclosure with rendered text overflow and container resizing.
  useEffect(() => {
    const element = ref.current;
    if (!text || !element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    const disconnect = observeResize(element, measure);
    measure();
    return disconnect;
  }, [text, expanded]);
  return (
    <div className={about ? "mt-3" : "mt-1"}>
      <p
        ref={ref}
        id={id}
        className={cn(
          "break-words text-sm leading-6 text-muted-foreground",
          !expanded && (about ? "line-clamp-3" : "line-clamp-2"),
        )}
      >
        {text}
      </p>
      {overflowing || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
          className="rounded-sm text-xs leading-6 text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      ) : null}
    </div>
  );
}

export function ProjectDescription({ view }: { view: ProjectOverviewView }) {
  return (
    <section aria-labelledby="project-about">
      <h2 id="project-about" className="text-sm font-semibold">
        About this project
      </h2>
      {view.snapshot?.overview ? (
        <ProjectSummary text={view.snapshot.overview.description} about />
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
    <section aria-labelledby="project-next">
      <div>
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
          className="mt-1 flex min-h-5 items-center gap-2 text-xs text-muted-foreground"
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
      <div className="mt-1">
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
              <li key={step.id} className="py-3 last:pb-0">
                <h3 className="break-words text-sm font-medium">{step.title}</h3>
                <ProjectSummary text={step.reason} />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
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
                          <span key={source.ref} className="break-words">
                            {source.title}
                          </span>
                        ),
                      )}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={!connected || opening !== null}
                      aria-busy={opening === step.id}
                      onClick={() => onOpen(step)}
                    >
                      {opening === step.id ? <Spinner aria-hidden /> : null}
                      {opening === step.id ? "Opening draft…" : "Open draft"}
                      {opening !== step.id ? <ArrowRightIcon aria-hidden /> : null}
                    </Button>
                    {view.canGiveFeedback ? (
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="xs"
                              aria-label={`Dismiss: ${step.title}`}
                            />
                          }
                        >
                          Dismiss <ChevronDownIcon aria-hidden />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem onClick={() => void view.dismiss(step, "done")}>
                            <CheckIcon aria-hidden /> Already done
                          </MenuItem>
                          <MenuItem onClick={() => void view.dismiss(step, "not-relevant")}>
                            <XIcon aria-hidden /> Not relevant
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
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
