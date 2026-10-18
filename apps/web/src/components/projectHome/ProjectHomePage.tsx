import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectNextStep, ServerProjectMemory } from "@t3tools/contracts";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { type EnvironmentQueryView, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { CheckIcon, FolderOpenIcon, PlusIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { hasUnseenCompletion } from "../Sidebar.logic";
import {
  projectHomeDays,
  projectHomeHeadline,
  projectHomeThreads,
  projectMemoryNote,
  projectThreadExcerpt,
  projectThreadStatus,
} from "./projectHomeView";

import { useComposerDraftStore } from "../../composerDraftStore";
import { mergeIdeaPrompt } from "../ideas/ideaDraft";
import { ProjectDescription, ProjectNextSteps } from "./ProjectNextSteps";
import { projectNextStepDraft } from "./projectNextStepDraft";
import { useProjectOverview } from "./useProjectOverview";

const UPDATES_SHOWN = 6;

type ProjectMemoryQuery = EnvironmentQueryView<ServerProjectMemory, unknown>;
const HISTORY_SHOWN = 5;

function memoryDayLabel(day: string) {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(year!, month! - 1, date);
  return value.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(value.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

function ThreadEntry({
  thread,
  report,
  framed = false,
}: {
  thread: EnvironmentThreadShell;
  report: string | undefined;
  framed?: boolean;
}) {
  const status = projectThreadStatus(thread);
  const excerpt = projectThreadExcerpt(thread, report);
  const unread = hasUnseenCompletion(thread);
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: thread.environmentId, threadId: thread.id }}
      className={cn(
        "group block min-w-0 px-4 py-3.5 transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        framed ? null : "rounded-lg",
      )}
    >
      <span className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 break-words text-sm font-medium text-foreground">
          {thread.title}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
          {unread ? <span className="font-medium text-primary">Unread</span> : null}
          {formatRelativeTimeLabel(thread.updatedAt)}
        </span>
      </span>
      {status || thread.branch ? (
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs">
          {status ? (
            <>
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)} />
              <span className={cn("shrink-0", status.textClass)}>{status.label}</span>
            </>
          ) : null}
          {status && thread.branch ? (
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
          ) : null}
          {thread.branch ? (
            <span className="flex min-w-0 font-mono text-2xs text-muted-foreground">
              <MiddleTruncate value={thread.branch} showTitle={false} />
            </span>
          ) : null}
        </span>
      ) : null}
      {excerpt ? (
        <span className="mt-2 line-clamp-3 break-words text-sm leading-6 text-foreground/80">
          {excerpt}
        </span>
      ) : null}
    </Link>
  );
}

function ProjectMemory({
  memory,
  connected,
  environmentLabel,
}: {
  memory: ProjectMemoryQuery;
  connected: boolean;
  environmentLabel: string;
}) {
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const note = useMemo(
    () => projectMemoryNote(memory.data?.markdown ?? ""),
    [memory.data?.markdown],
  );
  const history = showAll ? note.history : note.history.slice(0, HISTORY_SHOWN);
  const refreshing = memory.isPending && Boolean(memory.data);
  return (
    <section aria-labelledby="project-memory">
      <div className="flex items-center justify-between gap-3">
        <h2 id="project-memory" className="text-sm font-semibold">
          Project history
        </h2>
        {connected && memory.data?.state !== "disabled" ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Reload project history"
                  disabled={memory.isPending}
                  onClick={memory.refresh}
                />
              }
            >
              <RefreshIcon refreshing={refreshing} />
            </TooltipTrigger>
            <TooltipPopup>Reload project history</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        What Memory recorded about this project, one line per day of work.
      </p>
      <div className="mt-4">
        {!connected ? (
          <p className="text-sm text-muted-foreground">
            Available when {environmentLabel} reconnects.
          </p>
        ) : memory.error ? (
          <div role="alert" className="space-y-3">
            <p className="text-sm">Could not read project history.</p>
            <p className="break-words text-xs text-muted-foreground">{memory.error}</p>
            <Button variant="outline" size="xs" onClick={memory.refresh}>
              Try again
            </Button>
          </div>
        ) : !memory.data ? (
          <div role="status" aria-label="Loading project history" className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : memory.data.state === "disabled" ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Memory is off, so no history is kept for this project.
            </p>
            <Button
              variant="outline"
              size="xs"
              onClick={() => void navigate({ to: "/settings/general" })}
            >
              Memory settings
            </Button>
          </div>
        ) : note.history.length || note.sections.length ? (
          <div className="space-y-6">
            {history.length ? (
              <ol className="space-y-4">
                {history.map((entry) => (
                  <li
                    key={`${entry.day ?? ""}:${entry.text}`}
                    className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-3"
                  >
                    <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">
                      {entry.day ? memoryDayLabel(entry.day) : ""}
                    </span>
                    <p className="break-words text-sm leading-6">{entry.text}</p>
                  </li>
                ))}
              </ol>
            ) : null}
            {note.history.length > HISTORY_SHOWN ? (
              <Button variant="ghost" size="xs" onClick={() => setShowAll((value) => !value)}>
                {showAll ? "Show fewer days" : `Show all ${note.history.length} days`}
              </Button>
            ) : null}
            {note.sections.map((section) => (
              <section key={section.heading}>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                  {section.heading}
                </h3>
                <ul className="space-y-2">
                  {section.lines.map((line) => (
                    <li key={line} className="break-words text-sm leading-6">
                      {line}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing recorded yet. Memory adds a line after it summarizes a day of work in this
            project.
          </p>
        )}
      </div>
      {connected && memory.data?.state === "ready" && memory.data.markdown !== null ? (
        <details className="group mt-5 text-xs text-muted-foreground">
          <summary className="cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Source note
            {memory.data.updatedAt
              ? ` · updated ${formatRelativeTimeLabel(memory.data.updatedAt)}`
              : ""}
          </summary>
          <dl className="mt-3 space-y-1">
            <dt className="sr-only">File</dt>
            <dd className="break-all font-mono text-2xs">{memory.data.relativePath}</dd>
            {memory.data.updatedAt ? (
              <>
                <dt className="sr-only">Modified</dt>
                <dd>{new Date(memory.data.updatedAt).toLocaleString()}</dd>
              </>
            ) : null}
          </dl>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs leading-5 text-foreground">
            {memory.data.markdown}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

function ProjectOverview({
  project,
  title,
}: {
  project: SidebarProjectSnapshot["memberProjects"][number];
  title: string;
}) {
  const newThread = useNewThreadHandler();
  const environment = useEnvironment(project.environmentId);
  const environmentLabel = environment?.label ?? project.environmentLabel ?? "this environment";
  const connected = environment?.connection.phase === "connected";
  const canOpenInEditor = useAtomValue(
    shellEnvironment.openInEditor.permissionAtom(project.environmentId),
  );
  const canOpenFolder =
    connected &&
    canOpenInEditor &&
    environment?.serverConfig?.availableEditors.includes("file-manager") === true;
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, "Open project folder");
  const [openingFolder, setOpeningFolder] = useState(false);
  const folderInFlight = useRef(false);
  const [opening, setOpening] = useState<string | null>(null);
  const navigationInFlight = useRef(false);
  const openPage = async (action: string, request: () => Promise<unknown>) => {
    if (navigationInFlight.current) return;
    navigationInFlight.current = true;
    setOpening(action);
    try {
      await request();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open new thread",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      navigationInFlight.current = false;
      setOpening(null);
    }
  };
  const openFolder = async () => {
    if (!canOpenFolder || folderInFlight.current) return;
    folderInFlight.current = true;
    setOpeningFolder(true);
    try {
      const result = await openInEditor({
        environmentId: project.environmentId,
        input: { cwd: project.workspaceRoot, editor: "file-manager" },
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: "Folder opened",
          description: `Opened on ${environmentLabel}.`,
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open project folder",
        description: error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      folderInFlight.current = false;
      setOpeningFolder(false);
    }
  };
  const refs = useMemo(
    () => [scopeProjectRef(project.environmentId, project.id)],
    [project.environmentId, project.id],
  );
  const threads = useThreadShellsForProjectRefs(refs);
  const view = useMemo(() => projectHomeThreads(threads), [threads]);
  const memory = useEnvironmentQuery(
    connected
      ? serverEnvironment.projectMemory({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        })
      : null,
  );
  const overviewSupported =
    environment?.serverConfig?.environment.capabilities.projectOverview === true;
  const overview = useProjectOverview({
    environmentId: project.environmentId,
    projectId: project.id,
    connected,
    supported: overviewSupported,
  });
  const openNextStep = (step: ProjectNextStep) => {
    const saved = overview.snapshot?.overview;
    if (!saved || !connected) return;
    const prompt = projectNextStepDraft(saved, step);
    void openPage(step.id, async () => {
      const opened = await newThread(refs[0]!, { newDraftPrompt: prompt });
      if (!opened) throw new Error("This project could not open a draft. Please try again.");
      const store = useComposerDraftStore.getState();
      const existing = store.getComposerDraft(opened.draftId)?.prompt ?? "";
      const merged = mergeIdeaPrompt(existing, prompt);
      if (merged !== existing) store.setPrompt(opened.draftId, merged);
    });
  };
  const completionKey = view.recent
    .map((thread) => `${thread.id}:${thread.latestRun?.completedAt ?? ""}`)
    .join("|");
  const previousCompletionKey = useRef(completionKey);
  const refreshMemory = memory.refresh;
  useEffect(() => {
    if (previousCompletionKey.current === completionKey) return;
    previousCompletionKey.current = completionKey;
    if (connected) refreshMemory();
  }, [completionKey, connected, refreshMemory]);
  const reports = new Map(
    memory.data?.recentUpdates.map((report) => [report.threadId, report.text]) ?? [],
  );
  const [showAllUpdates, setShowAllUpdates] = useState(false);
  const shownUpdates = showAllUpdates ? view.updates : view.updates.slice(0, UPDATES_SHOWN);
  const days = projectHomeDays(shownUpdates);
  const unread = view.recent.filter(hasUnseenCompletion).length;
  const headline = projectHomeHeadline(view, connected);
  const needsYouStatus = view.needsYou[0] && projectThreadStatus(view.needsYou[0]);
  const workingStatus = view.working[0] && projectThreadStatus(view.working[0]);
  const facts = [
    `${view.recent.length} ${view.recent.length === 1 ? "thread" : "threads"}`,
    view.needsYou.length && view.working.length ? `${view.working.length} working` : null,
    unread ? `${unread} unread` : null,
    view.recent[0] ? `last activity ${formatRelativeTimeLabel(view.recent[0].updatedAt)}` : null,
  ].filter(Boolean);
  const createThread = () => void openPage("thread", () => newThread(refs[0]!));

  return (
    <>
      <header className="mb-10 flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <h1 id="project-home-title" className="break-words text-3xl font-semibold tracking-tight">
            {title}
          </h1>
          <p className="mt-3 flex items-center gap-2 text-base">
            {view.needsYou.length ? (
              <span aria-hidden className={cn("size-2 rounded-full", needsYouStatus?.dotClass)} />
            ) : view.working.length ? (
              <span aria-hidden className={cn("size-2 rounded-full", workingStatus?.dotClass)} />
            ) : view.recent.length ? (
              <CheckIcon aria-hidden className="size-4 text-muted-foreground" />
            ) : null}
            {headline}
          </p>
          {view.recent.length ? (
            <p className="mt-1 text-sm text-muted-foreground">{facts.join(" · ")}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={!connected || opening !== null}
            aria-busy={opening === "thread"}
            onClick={createThread}
          >
            {opening === "thread" ? <Spinner aria-hidden /> : <PlusIcon />}
            {opening === "thread" ? "Opening thread…" : "New thread"}
          </Button>
        </div>
      </header>
      <p role="status" className="sr-only">
        {opening ? "Opening new thread…" : ""}
      </p>
      {!connected ? (
        <div
          role="status"
          className="mb-8 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground"
        >
          Showing saved activity. Reconnect to {environmentLabel} to see what agents are doing now.
        </div>
      ) : null}
      <div className="grid gap-x-14 gap-y-12 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-10">
          {view.needsYou.length ? (
            <section aria-labelledby="project-needs-you">
              <h2 id="project-needs-you" className="mb-3 text-base font-semibold tracking-tight">
                Needs you
              </h2>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {view.needsYou.map((thread) => (
                  <li key={thread.id}>
                    <ThreadEntry thread={thread} report={reports.get(thread.id)} framed />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <ProjectNextSteps
            view={overview}
            environmentId={project.environmentId}
            connected={connected}
            supported={overviewSupported}
            opening={opening}
            onOpen={openNextStep}
          />
          {view.working.length ? (
            <section aria-labelledby="project-working">
              <h2 id="project-working" className="mb-3 text-base font-semibold tracking-tight">
                In progress
              </h2>
              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                {view.working.map((thread) => (
                  <li key={thread.id}>
                    <ThreadEntry thread={thread} report={reports.get(thread.id)} framed />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {view.updates.length ? (
            <section aria-labelledby="project-updates">
              <h2 id="project-updates" className="text-base font-semibold tracking-tight">
                Latest updates
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Each agent’s own last report. “Agent finished” means its run ended, not that the
                work was reviewed.
              </p>
              <div className="mt-5 space-y-7">
                {days.map((day) => (
                  <section key={day.label} aria-label={day.label}>
                    <h3 className="mb-1 text-xs font-medium text-muted-foreground">{day.label}</h3>
                    <ul className="-mx-4 space-y-1">
                      {day.threads.map((thread) => (
                        <li key={thread.id}>
                          <ThreadEntry thread={thread} report={reports.get(thread.id)} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
              {view.updates.length > UPDATES_SHOWN ? (
                <Button
                  className="mt-4"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAllUpdates((value) => !value)}
                >
                  {showAllUpdates
                    ? "Show fewer"
                    : `Show ${view.updates.length - UPDATES_SHOWN} older`}
                </Button>
              ) : null}
            </section>
          ) : null}
          {!view.recent.length ? (
            <section className="rounded-xl border border-dashed border-border px-6 py-10">
              <h2 className="text-base font-semibold tracking-tight">Start the first thread</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Threads you run in {title} appear here with their latest reports, so you can see
                where things stand when you come back.
              </p>
              <Button
                className="mt-5"
                size="sm"
                disabled={!connected || opening !== null}
                aria-busy={opening === "thread"}
                onClick={createThread}
              >
                {opening === "thread" ? <Spinner aria-hidden /> : <PlusIcon />}
                {opening === "thread" ? "Opening thread…" : "New thread"}
              </Button>
            </section>
          ) : null}
        </div>
        <aside className="min-w-0 space-y-9 lg:border-l lg:border-border lg:pl-8">
          <ProjectDescription view={overview} />
          <ProjectMemory
            memory={memory}
            connected={connected}
            environmentLabel={environmentLabel}
          />
          <section aria-labelledby="project-details" className="border-t border-border pt-6">
            <h2 id="project-details" className="sr-only">
              Project details
            </h2>
            <dl className="space-y-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Location</dt>
                <dd className="mt-0.5 min-w-0">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-left font-mono text-2xs text-foreground/80 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
                          aria-label={`Open project folder on ${environmentLabel}`}
                          aria-busy={openingFolder}
                          disabled={!canOpenFolder || openingFolder}
                          onClick={() => void openFolder()}
                        />
                      }
                    >
                      <MiddleTruncate value={project.workspaceRoot} showTitle={false} />
                      {openingFolder ? (
                        <Spinner size="xs" aria-hidden />
                      ) : (
                        <FolderOpenIcon className="size-3 shrink-0" aria-hidden />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup>
                      {project.workspaceRoot}
                      <br />
                      {!connected
                        ? `Reconnect to ${environmentLabel} to open this folder.`
                        : !canOpenFolder
                          ? "Opening folders is unavailable on this connection."
                          : `Open this folder on ${environmentLabel}.`}
                    </TooltipPopup>
                  </Tooltip>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Environment</dt>
                <dd className="mt-0.5 text-foreground/80">{environmentLabel}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}

export function ProjectHomePage({ projectKey }: { projectKey: string }) {
  const groups = useSidebarProjectGroups();
  const group = groups.find((candidate) => candidate.projectKey === projectKey);
  const [selected, setSelected] = useState<string | null>(null);
  const project =
    group?.memberProjects.find((member) => member.physicalProjectKey === selected) ??
    group?.memberProjects.find(
      (member) => member.environmentId === group.environmentId && member.id === group.id,
    ) ??
    group?.memberProjects[0];
  return (
    <main
      className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
      aria-labelledby="project-home-title"
    >
      <div className="mx-auto w-full max-w-5xl px-5 pb-12 pt-16 sm:px-9 sm:pt-12">
        {group && project ? (
          <>
            {group.memberProjects.length > 1 ? (
              <div
                className="mb-6 flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="Project copies"
              >
                <span aria-hidden className="mr-1 text-xs text-muted-foreground">
                  Copy
                </span>
                {group.memberProjects.map((member) => (
                  <Button
                    key={member.physicalProjectKey}
                    size="xs"
                    variant={member === project ? "secondary" : "ghost"}
                    aria-pressed={member === project}
                    onClick={() => setSelected(member.physicalProjectKey)}
                  >
                    <span className="max-w-60 truncate">
                      {member.workspaceRoot.split(/[\\/]/u).filter(Boolean).slice(-3).join("/")}
                    </span>
                  </Button>
                ))}
              </div>
            ) : null}
            <ProjectOverview
              key={project.physicalProjectKey}
              project={project}
              title={group.displayName}
            />
          </>
        ) : (
          <div role="status">
            <h1 id="project-home-title" className="text-xl font-semibold">
              Project overview
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              This project is not available. Reconnect to its environment or choose another project.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
