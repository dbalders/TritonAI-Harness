import { mergeTeamStorageResult } from "@t3tools/client-runtime/state/server";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  TeamProjectCommand,
  TeamProjectLink,
  TeamProjectResult,
  TeamStorageCommand,
  TeamStorageStatus,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { TeamDocuments } from "./TeamDocuments";

const retryable = (cause: unknown) =>
  cause instanceof Error &&
  "code" in cause &&
  (cause.code === "conflict" || cause.code === "unavailable" || cause.code === "invalid_request");

/** One request at a time; a newer mount or unmount discards late answers. */
function useTeamProjectRequest(environmentId: EnvironmentId) {
  const request = useAtomCommand(serverEnvironment.teamProjects, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
      inFlight.current = false;
    },
    [],
  );
  const run = useCallback(
    async (input: TeamProjectCommand): Promise<TeamProjectResult | { error: unknown } | null> => {
      if (inFlight.current) return null;
      inFlight.current = true;
      const requestId = ++generation.current;
      setBusy(true);
      setError(null);
      try {
        const response = await request({ environmentId, input });
        if (response._tag !== "Success") throw squashAtomCommandFailure(response);
        return generation.current === requestId ? response.value : null;
      } catch (cause) {
        if (generation.current !== requestId) return null;
        setError(cause instanceof Error ? cause.message : "Team projects are unavailable.");
        return { error: cause };
      } finally {
        if (generation.current === requestId) {
          inFlight.current = false;
          setBusy(false);
        }
      }
    },
    [environmentId, request],
  );
  return { run, busy, error };
}

/** Mounted inside one signed-in account's ready team, so account or team changes discard it. */
export function TeamProjects({
  environmentId,
  teamId,
  canWrite,
}: {
  environmentId: EnvironmentId;
  teamId: string;
  canWrite: boolean;
}) {
  const { run, busy, error } = useTeamProjectRequest(environmentId);
  const projects = useProjects();
  const [links, setLinks] = useState<readonly TeamProjectLink[] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [open, setOpen] = useState<ProjectId | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState<ProjectId | null>(null);
  const apply = useCallback(
    async (command: TeamProjectCommand) => {
      const result = await run(command);
      if (!result) return;
      if ("error" in result) {
        if (!retryable(result.error)) setLinks(null);
        return;
      }
      setLinks(result.projects);
      setConfirmUnlink(null);
      setOpen((current) =>
        result.projects.some((link) => link.projectId === current) ? current : null,
      );
    },
    [run],
  );
  useEffect(() => {
    void apply({ action: "list", teamId });
  }, [apply, teamId]);
  const linked = new Set(links?.map((link) => link.projectId));
  const available = projects.filter(
    (project) => project.environmentId === environmentId && !linked.has(project.id),
  );
  const openLink = links?.find((link) => link.projectId === open) ?? null;
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Team projects</h4>
        <p className="text-xs text-muted-foreground">
          Link a Harness project on this computer to work in this team’s memory. Linking does not
          share the project’s files or chats, and other members link their own projects.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {links === null ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void apply({ action: "list", teamId })}
        >
          {busy ? "Loading team projects…" : "Retry team projects"}
        </Button>
      ) : (
        <>
          {links.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border px-3">
              {links.map((link) => (
                <li key={link.projectId} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{link.projectTitle}</span>
                  <Button
                    size="sm"
                    variant={open === link.projectId ? "secondary" : "outline"}
                    disabled={busy}
                    onClick={() => setOpen(open === link.projectId ? null : link.projectId)}
                  >
                    {open === link.projectId ? "Close team memory" : "Open team memory"}
                  </Button>
                  {confirmUnlink === link.projectId ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() =>
                        void apply({ action: "unbind", teamId, projectId: link.projectId })
                      }
                    >
                      Confirm unlink
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setConfirmUnlink(link.projectId)}
                    >
                      Unlink
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No projects are linked yet.</p>
          )}
          {available.length ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const project = available.find((entry) => entry.id === choice);
                if (project) void apply({ action: "bind", teamId, projectId: project.id });
              }}
            >
              <label className="min-w-0 flex-1 space-y-1 text-xs">
                Harness project
                <select
                  aria-label="Harness project to link"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={choice}
                  disabled={busy}
                  onChange={(event) => setChoice(event.target.value)}
                >
                  <option value="">Choose a project…</option>
                  {available.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" disabled={busy || !choice}>
                Link to team
              </Button>
            </form>
          ) : links.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Add a project to Harness first, then link it here.
            </p>
          ) : null}
        </>
      )}
      {openLink ? (
        <TeamProjectMemory
          key={`${teamId}:${openLink.projectId}`}
          environmentId={environmentId}
          teamId={teamId}
          link={openLink}
          canWrite={canWrite}
        />
      ) : null}
    </section>
  );
}

/** Team memory for one linked project. Notes stay in shared storage and this view's memory. */
function TeamProjectMemory({
  environmentId,
  teamId,
  link,
  canWrite,
}: {
  environmentId: EnvironmentId;
  teamId: string;
  link: TeamProjectLink;
  canWrite: boolean;
}) {
  const { run, busy, error } = useTeamProjectRequest(environmentId);
  const [state, setState] = useState<TeamStorageStatus | null>(null);
  const { projectId } = link;
  // The server resolves the team from the project's link; the team id here only keeps the
  // shared document editor's command shape.
  const runStorage = useCallback(
    async (command: TeamStorageCommand) => {
      const input: TeamProjectCommand | null =
        command.action === "list-files"
          ? { action: "memory-list", projectId }
          : command.action === "read-file"
            ? { action: "memory-read", projectId, path: command.path }
            : command.action === "update-file"
              ? {
                  action: "memory-update",
                  projectId,
                  path: command.path,
                  etag: command.etag,
                  text: command.text,
                }
              : command.action === "delete-file"
                ? { action: "memory-delete", projectId, path: command.path, etag: command.etag }
                : command.action === "publish"
                  ? {
                      action: "memory-publish",
                      projectId,
                      recordId: command.recordId,
                      deviceId: command.deviceId,
                      title: command.title,
                      text: command.text,
                    }
                  : null;
      if (!input) return null;
      const result = await run(input);
      if (!result) return null;
      if ("error" in result) {
        if (!retryable(result.error)) setState(null);
        return null;
      }
      const next = result.storage;
      if (!next) return null;
      setState((previous) => mergeTeamStorageResult(previous, next, command));
      if (command.action === "publish" && next.document) {
        // Show the new note in the list; the listing keeps the open document.
        const listed = await run({ action: "memory-list", projectId });
        if (listed && !("error" in listed) && listed.storage) {
          const files = listed.storage;
          setState((previous) =>
            mergeTeamStorageResult(previous, files, { action: "list-files", teamId }),
          );
        }
      }
      return next;
    },
    [projectId, run, teamId],
  );
  useEffect(() => {
    void runStorage({ action: "list-files", teamId });
  }, [runStorage, teamId]);
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <h5 className="text-sm font-medium">Team memory for {link.projectTitle}</h5>
        <p className="text-xs text-muted-foreground">
          Everyone on this team can read these notes. New notes are labeled with this project.
          Harness does not copy them into the project folder, your personal memory, or agent
          conversations.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {state?.status === "disconnected" || state?.status === "pending" ? (
        <p className="text-sm text-muted-foreground">
          Connect Microsoft in Shared storage above, then refresh team memory.
        </p>
      ) : null}
      {state?.status === "not-configured" ? (
        <p className="text-sm text-muted-foreground">
          Your administrator needs to finish the Microsoft storage connection for this environment.
        </p>
      ) : null}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void runStorage({ action: "list-files", teamId })}
      >
        {busy ? "Loading team memory…" : "Refresh team memory"}
      </Button>
      {state?.status === "connected" ? (
        <>
          {state.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">No team memory has been published yet.</p>
          ) : null}
          <TeamDocuments
            teamId={teamId}
            document={state.document}
            files={state.files}
            canWrite={canWrite}
            busy={busy}
            run={runStorage}
            projectTitle={link.projectTitle}
          />
        </>
      ) : null}
    </div>
  );
}
