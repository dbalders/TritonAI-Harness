import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  ArrowUpRightIcon,
  CheckIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  PlusIcon,
  Settings2Icon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { projectHomeThreads, projectMemorySections, projectThreadExcerpt } from "./projectHomeView";

function ThreadRow({
  thread,
  label,
  report,
}: {
  thread: EnvironmentThreadShell;
  label?: string | undefined;
  report?: string | undefined;
}) {
  const navigate = useNavigate();
  const status = resolveThreadStatusPill({ thread });
  const failed = thread.runtime?.status === "failed" || thread.latestRun?.status === "failed";
  const excerpt = projectThreadExcerpt(thread, report);
  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: thread.environmentId, threadId: thread.id },
        })
      }
      className="group flex w-full min-w-0 gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <MessageSquareIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-medium">{thread.title}</span>
          <span className={`text-xs ${status?.colorClass ?? "text-muted-foreground"}`}>
            {label ?? status?.label ?? (failed ? "Needs attention" : "Thread")}
          </span>
        </span>
        {excerpt ? (
          <span className="mt-1 block line-clamp-2 text-xs leading-5 text-muted-foreground">
            {excerpt}
          </span>
        ) : null}
        {thread.branch ? (
          <span className="mt-1 block truncate font-mono text-2xs text-muted-foreground">
            {thread.branch}
          </span>
        ) : null}
      </span>
      <ArrowUpRightIcon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100"
      />
    </button>
  );
}

function ProjectOverview({
  project,
  projectKey,
  title,
}: {
  project: SidebarProjectSnapshot["memberProjects"][number];
  projectKey: string;
  title: string;
}) {
  const navigate = useNavigate();
  const newThread = useNewThreadHandler();
  const environment = useEnvironment(project.environmentId);
  const connected = environment?.connection.phase === "connected";
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
  const sections = useMemo(
    () => projectMemorySections(memory.data?.markdown ?? ""),
    [memory.data?.markdown],
  );
  const reports = new Map(
    memory.data?.recentUpdates.map((report) => [report.threadId, report.text]) ?? [],
  );
  return (
    <>
      <div className="mb-9 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <FolderOpenIcon aria-hidden className="size-3.5" />
            Project overview<span aria-hidden>·</span>
            {environment?.label ?? project.environmentLabel ?? "Environment"}
          </div>
          <h1 id="project-home-title" className="text-3xl font-semibold tracking-tight">
            {title}
          </h1>
          <Tooltip>
            <TooltipTrigger
              render={<p className="mt-2 max-w-2xl truncate text-xs text-muted-foreground" />}
            >
              {project.workspaceRoot}
            </TooltipTrigger>
            <TooltipPopup>{project.workspaceRoot}</TooltipPopup>
          </Tooltip>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void navigate({
                to: "/settings/projects",
                search: {
                  project: projectKey,
                  machine: project.environmentId,
                  checkout: project.physicalProjectKey,
                },
              })
            }
            aria-label="Project settings"
          >
            <Settings2Icon />
            Settings
          </Button>
          <Button size="sm" disabled={!connected} onClick={() => void newThread(refs[0]!)}>
            <PlusIcon />
            New thread
          </Button>
        </div>
      </div>
      {!connected ? (
        <div
          role="status"
          className="mb-6 rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground"
        >
          Reconnect to {environment?.label ?? "this environment"} to see current project activity.
          Saved thread information may be out of date.
        </div>
      ) : null}
      <div className="mb-8 flex flex-wrap gap-x-5 gap-y-2 border-y border-border py-3 text-xs text-muted-foreground">
        <span>
          {view.recent.length} {view.recent.length === 1 ? "thread" : "threads"}
        </span>
        <span>{view.working.length} in progress</span>
        <span>{view.needsYou.length} needing you</span>
        <span className="sm:ml-auto">{connected ? "Activity updates live" : "Saved activity"}</span>
      </div>
      <div className="grid gap-x-12 gap-y-9 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-9">
          <section aria-labelledby="project-next">
            <h2 id="project-next" className="mb-3 text-base font-semibold tracking-tight">
              What’s next
            </h2>
            {view.needsYou.length ? (
              <div className="-mx-3">
                {view.needsYou.slice(0, 6).map((thread) => (
                  <ThreadRow key={thread.id} thread={thread} report={reports.get(thread.id)} />
                ))}
              </div>
            ) : (
              <div className="py-2">
                <p className="flex items-center gap-2 text-sm">
                  <CheckIcon aria-hidden className="size-4 text-muted-foreground" />
                  {connected ? "Nothing waiting on you" : "No saved requests waiting on you"}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {view.working.length
                    ? "Agents are still working. Open a thread below to follow along."
                    : "Pick up a recent conversation or start the next piece of work."}
                </p>
              </div>
            )}
          </section>
          {view.working.length ? (
            <section aria-labelledby="project-working">
              <h2 id="project-working" className="mb-3 text-base font-semibold tracking-tight">
                In progress
              </h2>
              <div className="-mx-3">
                {view.working.slice(0, 4).map((thread) => (
                  <ThreadRow key={thread.id} thread={thread} report={reports.get(thread.id)} />
                ))}
              </div>
            </section>
          ) : null}
          <section aria-labelledby="project-recent">
            <h2 id="project-recent" className="mb-1 text-base font-semibold tracking-tight">
              Recent work
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Latest conversations, with their original updates.
            </p>
            {view.recent.length ? (
              <div className="-mx-3">
                {view.recent.slice(0, 8).map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    report={reports.get(thread.id)}
                    label={view.finished.includes(thread) ? "Agent finished" : undefined}
                  />
                ))}
              </div>
            ) : (
              <div className="py-5 text-sm text-muted-foreground">
                Your project starts here. Create a thread and its activity will appear
                automatically.
              </div>
            )}
          </section>
        </div>
        <section
          className="min-w-0 lg:border-l lg:border-border lg:pl-9"
          aria-labelledby="project-memory"
        >
          <div className="mb-1 flex items-center justify-between gap-3">
            <h2 id="project-memory" className="text-base font-semibold tracking-tight">
              Project memory
            </h2>
            <Button
              variant="ghost"
              size="xs"
              disabled={!connected || memory.isPending}
              onClick={memory.refresh}
            >
              Refresh
            </Button>
          </div>
          <p className="mb-5 text-xs leading-5 text-muted-foreground">
            Built in the background from your threads. Open a conversation to check the original
            context.
          </p>
          {!connected ? (
            <p className="text-sm text-muted-foreground">
              Memory will be available when this environment reconnects.
            </p>
          ) : memory.error ? (
            <div role="alert">
              <p className="text-sm text-muted-foreground">Could not read project memory.</p>
              <p className="mt-2 text-xs text-muted-foreground">{memory.error}</p>
              <div className="mt-3">
                <Button variant="outline" size="sm" onClick={memory.refresh}>
                  Try again
                </Button>
              </div>
            </div>
          ) : !memory.data ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading project memory…
            </p>
          ) : memory.data.state === "disabled" ? (
            <div>
              <p className="text-sm text-muted-foreground">
                Turn on Memory to build a lasting project history.
              </p>
              <div className="mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void navigate({ to: "/settings/general" })}
                >
                  Open memory settings
                </Button>
              </div>
            </div>
          ) : sections.length ? (
            <div className="space-y-6">
              {sections.map((section) => (
                <section key={section.heading}>
                  <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                    {section.heading}
                  </h3>
                  <ul className="space-y-3">
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
            <div>
              <p className="text-sm">Still getting to know this project</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                As Memory processes your conversations, its summaries will appear here. Recent work
                is already available on the left.
              </p>
            </div>
          )}
          {connected && memory.data?.state === "ready" ? (
            <details className="mt-6 border-t border-border pt-4">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Memory source
                {memory.data.updatedAt
                  ? ` · ${new Date(memory.data.updatedAt).toLocaleString()}`
                  : ""}
              </summary>
              <p className="mt-3 break-all font-mono text-2xs text-muted-foreground">
                {memory.data.relativePath}
              </p>
              <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs leading-5">
                {memory.data.markdown}
              </pre>
            </details>
          ) : null}
          <div className="mt-7 border-t border-border pt-4">
            <p className="text-xs leading-5 text-muted-foreground">
              Have evidence to turn into a reviewed action?
            </p>
            <div className="mt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void navigate({
                    to: "/project-brief/$environmentId/$projectId",
                    params: { environmentId: project.environmentId, projectId: project.id },
                  })
                }
              >
                Open project brief
                <ArrowUpRightIcon />
              </Button>
            </div>
          </div>
        </section>
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
      <div className="mx-auto w-full max-w-6xl px-5 pb-10 pt-16 sm:px-9 sm:pt-14">
        {group && project ? (
          <>
            {group.memberProjects.length > 1 ? (
              <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Project copies">
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
              projectKey={group.projectKey}
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
