import { mergeTeamStorageResult } from "@t3tools/client-runtime/state/server";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  StuckTeamProjectLink,
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
export function useTeamProjectRequest(environmentId: EnvironmentId) {
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
  linkProjectId,
  authors,
  canWrite,
  onLinksChange,
}: {
  environmentId: EnvironmentId;
  teamId: string;
  /** Chosen in the link form when it can still be linked. */
  linkProjectId: ProjectId | null;
  /** Current members' names by author folder. */
  authors: Readonly<Record<string, string>>;
  canWrite: boolean;
  /**
   * Whether any project here is linked, after each load, link, or unlink. A local copy of the team
   * needs a link, and losing the last one detaches it.
   */
  onLinksChange?: (linked: boolean) => void;
}) {
  const { run, busy, error } = useTeamProjectRequest(environmentId);
  const projects = useProjects();
  const [links, setLinks] = useState<readonly TeamProjectLink[] | null>(null);
  const [preferredChoice, setChoice] = useState<string>(linkProjectId ?? "");
  const [open, setOpen] = useState<{ projectId: ProjectId; kind: "memory" | "skill" } | null>(null);
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
      onLinksChange?.(result.projects.length > 0);
      setOpen((current) =>
        result.projects.some((link) => link.projectId === current?.projectId) ? current : null,
      );
    },
    [onLinksChange, run],
  );
  useEffect(() => {
    void apply({ action: "list", teamId });
  }, [apply, teamId]);
  const linked = new Set(links?.map((link) => link.projectId));
  const available = projects.filter(
    (project) => project.environmentId === environmentId && !linked.has(project.id),
  );
  const choice = available.some((project) => project.id === preferredChoice) ? preferredChoice : "";
  const openLink = links?.find((link) => link.projectId === open?.projectId) ?? null;
  const toggle = (projectId: ProjectId, kind: "memory" | "skill") =>
    setOpen(open?.projectId === projectId && open.kind === kind ? null : { projectId, kind });
  const isOpen = (projectId: ProjectId, kind: "memory" | "skill") =>
    open?.projectId === projectId && open.kind === kind;
  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Team projects</h4>
        <p className="text-xs text-muted-foreground">
          Link a project in this Harness environment to work with this team’s memory and skills.
          Linking does not share the project’s files or chats, and other members link their own
          projects.
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
                    variant={isOpen(link.projectId, "memory") ? "secondary" : "outline"}
                    disabled={busy}
                    onClick={() => toggle(link.projectId, "memory")}
                  >
                    {isOpen(link.projectId, "memory") ? "Close team memory" : "Open team memory"}
                  </Button>
                  <Button
                    size="sm"
                    variant={isOpen(link.projectId, "skill") ? "secondary" : "outline"}
                    disabled={busy}
                    onClick={() => toggle(link.projectId, "skill")}
                  >
                    {isOpen(link.projectId, "skill") ? "Close team skills" : "Open team skills"}
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
      {openLink && open ? (
        <TeamProjectDocuments
          key={`${teamId}:${openLink.projectId}:${open.kind}`}
          kind={open.kind}
          environmentId={environmentId}
          teamId={teamId}
          link={openLink}
          authors={authors}
          canWrite={canWrite}
        />
      ) : null}
    </section>
  );
}

/**
 * Projects in this environment linked to a team the signed-in account can't open, or one that
 * isn't ready. No team page can unlink them, so this is their way out. Shows nothing without any.
 */
export function StuckProjectLinks({ environmentId }: { environmentId: EnvironmentId }) {
  const { run, busy, error } = useTeamProjectRequest(environmentId);
  const [links, setLinks] = useState<readonly StuckTeamProjectLink[]>([]);
  const [confirmRemove, setConfirmRemove] = useState<ProjectId | null>(null);
  useEffect(() => {
    void run({ action: "stuck-links" }).then((result) => {
      if (result && !("error" in result)) setLinks(result.stuckLinks ?? []);
    });
  }, [run]);
  const remove = async (projectId: ProjectId) => {
    const result = await run({ action: "remove-link", projectId });
    if (!result) return;
    setConfirmRemove(null);
    if (!("error" in result))
      setLinks((current) => current.filter((link) => link.projectId !== projectId));
  };
  if (!links.length) return null;
  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <div className="space-y-1">
        <h3 className="font-medium">Stuck project links</h3>
        <p className="text-xs text-muted-foreground">
          These projects are linked to a team you can’t open, or one waiting for an administrator
          check, so their team memory and skills can’t be used. Removing a link turns its team
          skills off for everyone using the project. You can then link the project to a team again.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-border rounded-lg border border-border px-3">
        {links.map((link) => (
          <li key={link.projectId} className="flex flex-wrap items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{link.projectTitle}</p>
              <p className="text-xs text-muted-foreground">
                {link.reason === "held"
                  ? `${link.teamName ?? "Its team"} is waiting for an administrator check`
                  : "Linked to a team you can’t open"}
              </p>
            </div>
            {confirmRemove === link.projectId ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void remove(link.projectId)}
              >
                Confirm remove
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`Remove team link from ${link.projectTitle}`}
                onClick={() => setConfirmRemove(link.projectId)}
              >
                Remove link
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Team memory or skills for one linked project. Documents stay in shared storage and this view's
 * memory; the server resolves the team and folder from the project's link.
 */
function TeamProjectDocuments({
  kind,
  environmentId,
  teamId,
  link,
  authors,
  canWrite,
}: {
  kind: "memory" | "skill";
  environmentId: EnvironmentId;
  teamId: string;
  link: TeamProjectLink;
  authors: Readonly<Record<string, string>>;
  canWrite: boolean;
}) {
  const { run, busy, error } = useTeamProjectRequest(environmentId);
  const [state, setState] = useState<TeamStorageStatus | null>(null);
  const { projectId } = link;
  // The server resolves the team from the project's link; the team id here only keeps the
  // shared document editor's command shape.
  const runStorage = useCallback(
    async (command: TeamStorageCommand) => {
      const input = projectCommand(kind, projectId, command);
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
        const listed = await run({
          action: kind === "skill" ? "skill-list" : "memory-list",
          projectId,
        });
        if (listed && !("error" in listed) && listed.storage) {
          const files = listed.storage;
          setState((previous) =>
            mergeTeamStorageResult(previous, files, { action: "list-files", teamId }),
          );
        }
      }
      return next;
    },
    [kind, projectId, run, teamId],
  );
  useEffect(() => {
    void runStorage({ action: "list-files", teamId });
  }, [runStorage, teamId]);
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <h5 className="text-sm font-medium">
          Team {kind === "skill" ? "skills" : "memory"} for {link.projectTitle}
        </h5>
        <p className="text-xs text-muted-foreground">
          {kind === "skill"
            ? "Everyone on this team can read these skills, and editors can change them. To use one, open a thread in this project and choose Team → Use a team skill in message, or turn it on for every message in Settings → Skills. Harness never installs them, and adds one to messages only after you review and turn it on."
            : "Everyone on this team can read these notes. New notes are labeled with this project. Harness copies them into your memory folder only while you keep a local copy of the team, and never into the project folder or agent conversations."}
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
        {busy
          ? `Loading team ${kind === "skill" ? "skills" : "memory"}…`
          : `Refresh team ${kind === "skill" ? "skills" : "memory"}`}
      </Button>
      {state?.status === "connected" ? (
        <>
          {state.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {kind === "skill"
                ? "No skills have been published to this team yet."
                : "No team memory has been published yet."}
            </p>
          ) : null}
          <TeamDocuments
            teamId={teamId}
            document={state.document}
            files={state.files}
            authors={authors}
            canWrite={canWrite}
            busy={busy}
            run={runStorage}
            projectTitle={link.projectTitle}
            projectKind={kind}
          />
        </>
      ) : null}
    </div>
  );
}

/** The project command for a shared-document action; the server pins it to the linked team. */
function projectCommand(
  kind: "memory" | "skill",
  projectId: ProjectId,
  command: TeamStorageCommand,
): TeamProjectCommand | null {
  switch (command.action) {
    case "list-files":
      return { action: kind === "skill" ? "skill-list" : "memory-list", projectId };
    case "read-file":
      return kind === "skill"
        ? { action: "skill-read", projectId, path: command.path }
        : { action: "memory-read", projectId, path: command.path };
    case "list-versions":
      return {
        action: kind === "skill" ? "skill-versions" : "memory-versions",
        projectId,
        path: command.path,
      };
    case "read-version":
      return {
        action: kind === "skill" ? "skill-read-version" : "memory-read-version",
        projectId,
        path: command.path,
        versionId: command.versionId,
      };
    case "update-file":
      return {
        action: kind === "skill" ? "skill-update" : "memory-update",
        projectId,
        path: command.path,
        etag: command.etag,
        text: command.text,
      };
    case "delete-file":
      return {
        action: kind === "skill" ? "skill-delete" : "memory-delete",
        projectId,
        path: command.path,
        etag: command.etag,
      };
    case "publish": {
      const document = {
        projectId,
        recordId: command.recordId,
        deviceId: command.deviceId,
        title: command.title,
        text: command.text,
      };
      if (kind !== "skill") return { action: "memory-publish", ...document };
      return command.description
        ? { action: "skill-publish", ...document, description: command.description }
        : null;
    }
    default:
      return null;
  }
}
