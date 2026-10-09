// @effect-diagnostics cryptoRandomUUID:off - Browser-generated record IDs; this component does not run in an Effect runtime.
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  formatTeamNote,
  type EnvironmentId,
  type ProjectId,
  type TeamDocument,
  type TeamProjectCommand,
  type TeamProjectLink,
  type TeamsResult,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useUcsdAccount } from "../../hooks/useUcsdAccount";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { teamDocumentDeviceId } from "./TeamDocuments";
import { useTeamProjectRequest } from "./TeamProjects";
import { formatTeamMemoryContext, teamNoteTitle } from "./threadTeamContext";

const MAX_NOTE_BYTES = 64 * 1024;
type Share = Extract<TeamProjectCommand, { action: "share" }>;

/**
 * Team dialogs are mounted per signed-in campus identity, so an account change discards
 * every unsent team draft, preview, and loaded note.
 */
function SignedIn({
  environmentId,
  children,
}: {
  environmentId: EnvironmentId;
  children: (identity: string) => React.ReactNode;
}) {
  const { account } = useUcsdAccount(environmentId);
  const profile = account?.status === "signed-in" ? account.profile : null;
  if (!account) return <p className="text-sm text-muted-foreground">Checking your account…</p>;
  if (!profile)
    return (
      <p className="text-sm text-muted-foreground">
        Sign in with UC San Diego from{" "}
        <Link to="/teams" className="underline">
          Teams
        </Link>{" "}
        to use team memory.
      </p>
    );
  return children(`${profile.issuer}:${profile.subject}`);
}

/** Publishes only the text the user reviewed, as a memory note in a team they choose. */
export function ShareToTeamDialog({
  environmentId,
  threadId,
  projectTitle,
  initialText,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Shown in the preview; the server sets the saved label from the thread's project. */
  projectTitle: string;
  initialText: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Share to a team</DialogTitle>
          <DialogDescription>
            Only the text you review here is shared. The chat, your personal memory, and project
            files stay private.
          </DialogDescription>
        </DialogHeader>
        <SignedIn environmentId={environmentId}>
          {(identity) => (
            <ShareForm
              key={`${identity}:${threadId}`}
              environmentId={environmentId}
              threadId={threadId}
              projectTitle={projectTitle}
              initialText={initialText}
              onDone={() => onOpenChange(false)}
            />
          )}
        </SignedIn>
      </DialogPopup>
    </Dialog>
  );
}

function ShareForm({
  environmentId,
  threadId,
  projectTitle,
  initialText,
  onDone,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectTitle: string;
  initialText: string;
  onDone: () => void;
}) {
  const teamsRequest = useAtomCommand(serverEnvironment.teams, { reportFailure: false });
  const { run, busy, error } = useTeamProjectRequest(environmentId);
  const [teams, setTeams] = useState<TeamsResult["teams"] | null>(null);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [teamId, setTeamId] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState(initialText);
  const [reviewing, setReviewing] = useState(false);
  const pending = useRef<Share | null>(null);
  const [deviceId] = useState(teamDocumentDeviceId);
  const loadTeams = async () => {
    setTeamsError(null);
    const response = await teamsRequest({ environmentId, input: { action: "list" } });
    if (response._tag !== "Success") {
      const cause = squashAtomCommandFailure(response);
      setTeamsError(cause instanceof Error ? cause.message : "Teams could not be reached.");
      return;
    }
    const writable = response.value.teams.filter(
      (team) => team.state === "ready" && (team.role !== "reader" || team.canManage),
    );
    setTeams(writable);
    setTeamId((current) =>
      writable.some((team) => team.id === current) ? current : (writable[0]?.id ?? ""),
    );
  };
  useEffect(() => {
    void loadTeams();
    // Loads once per mount; the dialog remounts for another account or thread.
  }, []);
  const team = teams?.find((entry) => entry.id === teamId) ?? null;
  const note = formatTeamNote({ title, project: projectTitle.slice(0, 80), text });
  const tooLarge = new TextEncoder().encode(note).byteLength > MAX_NOTE_BYTES;
  const ready = team !== null && title.trim() !== "" && text.trim() !== "" && !tooLarge;
  const share = async () => {
    if (!team) return;
    const previous = pending.current;
    // A retry of the same reviewed note reuses its record, so a lost response cannot duplicate it.
    const command: Share =
      previous && previous.teamId === team.id && previous.title === title && previous.text === text
        ? previous
        : {
            action: "share",
            teamId: team.id,
            threadId,
            recordId: crypto.randomUUID(),
            deviceId,
            title,
            text,
          };
    pending.current = command;
    const result = await run(command);
    if (result && !("error" in result) && result.storage?.document) {
      pending.current = null;
      toastManager.add({
        type: "success",
        title: `Shared to ${team.name}`,
        description: "Find or remove it under Teams → Team projects or shared storage.",
      });
      onDone();
    }
  };
  if (teams === null)
    return (
      <DialogPanel>
        <div className="space-y-3">
          {teamsError ? (
            <>
              <p role="alert" className="text-sm text-destructive">
                {teamsError}
              </p>
              <Button variant="outline" onClick={() => void loadTeams()}>
                Retry
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Loading your teams…</p>
          )}
        </div>
      </DialogPanel>
    );
  if (teams.length === 0)
    return (
      <DialogPanel>
        <p className="text-sm text-muted-foreground">
          You can share once you are an editor or owner of a ready team. Manage teams in{" "}
          <Link to="/teams" className="underline">
            Teams
          </Link>
          .
        </p>
      </DialogPanel>
    );
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        if (reviewing) void share();
        else setReviewing(true);
      }}
    >
      <DialogPanel>
        <div className="space-y-3">
          {reviewing && team ? (
            <>
              <p className="text-sm">
                This note will be saved in <strong>{team.name}</strong>’s shared Memory folder.
                Every team member, including readers, can open and copy it. Removing it later
                deletes the note, but not copies people already made.
              </p>
              <pre
                aria-label="Exact note to share"
                className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap"
              >
                {note}
              </pre>
            </>
          ) : (
            <>
              <label className="block space-y-1 text-xs">
                Team
                <select
                  aria-label="Team to share with"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={teamId}
                  disabled={busy}
                  onChange={(event) => setTeamId(event.target.value)}
                >
                  {teams.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-xs">
                Title
                <Input
                  aria-label="Shared note title"
                  value={title}
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="What is this about?"
                  required
                />
              </label>
              <label className="block space-y-1 text-xs">
                Text to share
                <Textarea
                  aria-label="Text to share"
                  value={text}
                  disabled={busy}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="Paste or write the summary to share. Remove anything private."
                  className="min-h-40"
                />
              </label>
              {tooLarge ? (
                <p role="alert" className="text-xs text-destructive">
                  Shared notes must be smaller than 64 KB.
                </p>
              ) : null}
            </>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error} Your text has been kept.
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        {reviewing ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setReviewing(false)}
          >
            Edit
          </Button>
        ) : null}
        <Button type="submit" disabled={!ready || busy}>
          {reviewing ? (busy ? "Sharing…" : `Share to ${team?.name ?? "team"}`) : "Review"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Loads one note from the project's linked team and adds it to the draft after review. */
export function TeamMemoryDialog({
  environmentId,
  projectId,
  open,
  onOpenChange,
  onInsert,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Returns false when the composer could not take the text. */
  onInsert: (text: string) => boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add team memory</DialogTitle>
          <DialogDescription>
            Choose one note from this project’s team. It is added to your message where you can edit
            it, and is sent only if you send the message.
          </DialogDescription>
        </DialogHeader>
        <SignedIn environmentId={environmentId}>
          {(identity) => (
            <MemoryPicker
              key={`${identity}:${projectId}`}
              environmentId={environmentId}
              projectId={projectId}
              onInsert={(text) => {
                if (!onInsert(text)) return false;
                onOpenChange(false);
                return true;
              }}
            />
          )}
        </SignedIn>
      </DialogPopup>
    </Dialog>
  );
}

function MemoryPicker({
  environmentId,
  projectId,
  onInsert,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onInsert: (text: string) => boolean;
}) {
  const { run, busy, error } = useTeamProjectRequest(environmentId);
  const [link, setLink] = useState<TeamProjectLink | null | "unlinked">(null);
  const [files, setFiles] = useState<readonly string[] | null>(null);
  const [note, setNote] = useState<TeamDocument | null>(null);
  const [changed, setChanged] = useState(false);
  const load = async () => {
    setNote(null);
    const found = await run({ action: "project-link", projectId });
    if (!found) return;
    if ("error" in found) {
      const code = (found.error as { code?: unknown }).code;
      if (code === "not_found") setLink("unlinked");
      return;
    }
    const current = found.projects[0];
    if (!current) return setLink("unlinked");
    setLink(current);
    const listed = await run({ action: "memory-list", projectId });
    if (listed && !("error" in listed))
      setFiles((listed.storage?.files ?? []).map((file) => file.path).toSorted());
  };
  useEffect(() => {
    void load();
    // Loads once per mount; the dialog remounts for another account or project.
  }, []);
  const read = async (path: string) => {
    const result = await run({ action: "memory-read", projectId, path });
    if (!result || "error" in result) return null;
    return result.storage?.document ?? null;
  };
  const add = async () => {
    if (!note || typeof link !== "object" || !link) return;
    // Reread so membership is checked again and the user adds what the team has now.
    const fresh = await read(note.path);
    if (!fresh) return;
    if (fresh.text !== note.text) {
      setNote(fresh);
      setChanged(true);
      return;
    }
    if (
      !onInsert(
        formatTeamMemoryContext({ teamName: link.teamName, path: fresh.path, text: fresh.text }),
      )
    )
      toastManager.add({
        type: "warning",
        title: "The composer is not ready",
        description: "Try again after the connection or pending input is resolved.",
      });
  };
  if (link === "unlinked")
    return (
      <DialogPanel>
        <p className="text-sm text-muted-foreground">
          This project is not linked to a team you can open. Link it from{" "}
          <Link to="/teams" className="underline">
            Teams
          </Link>{" "}
          → your team → Team projects.
        </p>
      </DialogPanel>
    );
  return (
    <>
      <DialogPanel>
        <div className="space-y-3">
          {link ? (
            <p className="text-xs text-muted-foreground">
              Team: <span className="text-foreground">{link.teamName}</span>
            </p>
          ) : null}
          {error ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : null}
          {note ? (
            <>
              {changed ? (
                <p role="status" className="text-sm">
                  This note changed since you opened it. Review the current text below.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Exactly this will be added to your message:
              </p>
              <pre
                aria-label="Team memory to add"
                className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap"
              >
                {typeof link === "object" && link
                  ? formatTeamMemoryContext({
                      teamName: link.teamName,
                      path: note.path,
                      text: note.text,
                    })
                  : note.text}
              </pre>
              <p className="text-xs text-muted-foreground">
                Once sent, the text stays in this conversation and the agent’s context even if the
                note or your team access is later removed.
              </p>
            </>
          ) : files === null ? (
            error ? null : (
              <p className="text-sm text-muted-foreground">Loading team memory…</p>
            )
          ) : files.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This team has no memory notes yet. Share one from a thread or from Teams.
            </p>
          ) : (
            <ul className="max-h-72 divide-y divide-border overflow-auto rounded-lg border border-border px-3">
              {files.map((path) => (
                <li key={path} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {path.split("/").slice(1).join("/")}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void read(path).then((document) => {
                        setChanged(false);
                        if (document) setNote(document);
                      })
                    }
                  >
                    Preview
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogPanel>
      {note ? (
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setNote(null)}>
            Back
          </Button>
          <Button disabled={busy} onClick={() => void add()}>
            Add “{teamNoteTitle(note.text, note.path)}” to message
          </Button>
        </DialogFooter>
      ) : null}
    </>
  );
}
