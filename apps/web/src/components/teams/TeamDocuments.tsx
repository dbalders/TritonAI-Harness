// @effect-diagnostics cryptoRandomUUID:off - Browser-generated request/device IDs; this component does not run in an Effect runtime.
import type { TeamDocument, TeamStorageCommand, TeamStorageStatus } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

type Publish = Extract<TeamStorageCommand, { action: "publish" }>;
export function teamDocumentDeviceId() {
  try {
    const saved = localStorage.getItem("tritonai-team-document-device");
    if (saved && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(saved)) return saved;
    const next = crypto.randomUUID();
    localStorage.setItem("tritonai-team-document-device", next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * Drafts live only in this account/team's mounted view. Skill documents are shared text: nothing
 * here installs or runs them, and an agent sees one only when a user adds it to a message.
 */
export function TeamDocuments({
  teamId,
  document,
  files,
  canWrite,
  busy,
  run,
  projectTitle,
  projectKind = "memory",
}: {
  teamId: string;
  document: TeamDocument | null;
  files: TeamStorageStatus["files"];
  canWrite: boolean;
  busy: boolean;
  run: (command: TeamStorageCommand) => Promise<TeamStorageStatus | null>;
  /** Set when shown for a linked Harness project: one kind of document, labeled with it. */
  projectTitle?: string;
  projectKind?: "memory" | "skill";
}) {
  const [kind, setKind] = useState<Publish["kind"]>(projectKind);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [project, setProject] = useState("");
  const [text, setText] = useState("");
  const [edit, setEdit] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [ownDevice] = useState(teamDocumentDeviceId);
  const pending = useRef<Publish | null>(null);
  useEffect(() => {
    setEdit(document?.text ?? "");
    setConfirmDelete(false);
  }, [document]);
  const publish = async () => {
    const previous = pending.current;
    const command: Publish =
      previous &&
      previous.kind === kind &&
      previous.title === title &&
      (previous.description ?? "") === (kind === "skill" ? description : "") &&
      previous.project === project &&
      previous.text === text
        ? previous
        : {
            action: "publish",
            teamId,
            recordId: crypto.randomUUID(),
            deviceId: ownDevice,
            kind,
            title,
            ...(kind === "skill" ? { description } : {}),
            project,
            text,
          };
    pending.current = command;
    const result = await run(command);
    if (result?.document) {
      pending.current = null;
      setTitle("");
      setDescription("");
      setText("");
    }
  };
  const managedFiles = files.filter((file) => /^(Memory|SOPs|Skills)\/.+\.md$/u.test(file.path));
  return (
    <div className="space-y-4">
      {projectTitle === undefined ? (
        <div className="space-y-1">
          <h4 className="text-sm font-medium">Team knowledge</h4>
          <p className="text-xs text-muted-foreground">
            Share a work summary, SOP, or skill document with this team. Project labels organize
            notes; all team members can read them. Skill documents are shared instructions;
            publishing does not install them. Members use one by adding it to a message in a linked
            project.
          </p>
        </div>
      ) : null}
      {canWrite ? (
        <form
          className="space-y-3 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          {projectTitle === undefined ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                Document type
                <select
                  aria-label="Document type"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={kind}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "memory" || value === "sop" || value === "skill") setKind(value);
                  }}
                >
                  <option value="memory">Work summary</option>
                  <option value="sop">SOP</option>
                  <option value="skill">Skill document</option>
                </select>
              </label>
              <label className="space-y-1 text-xs">
                Project label (optional)
                <Input
                  aria-label="Document project"
                  value={project}
                  maxLength={80}
                  disabled={busy}
                  onChange={(event) => setProject(event.target.value)}
                  placeholder="Team-wide"
                />
              </label>
            </div>
          ) : null}
          <label className="block space-y-1 text-xs">
            Title
            <Input
              aria-label="Document title"
              value={title}
              maxLength={80}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
              required
            />
          </label>
          {kind === "skill" ? (
            <label className="block space-y-1 text-xs">
              What it’s for
              <Input
                aria-label="Skill description"
                value={description}
                maxLength={200}
                disabled={busy}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="When a teammate should use this skill"
                required
              />
            </label>
          ) : null}
          <label className="block space-y-1 text-xs">
            {kind === "skill" ? "Instructions" : "Content"}
            <Textarea
              aria-label="New document content"
              value={text}
              maxLength={60000}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              className="min-h-32"
              placeholder={
                kind === "skill"
                  ? "Write the steps an agent should follow. Scripts and attachments aren’t supported."
                  : "Write a summary or reusable instructions…"
              }
              required
            />
          </label>
          <Button
            type="submit"
            disabled={
              busy || !title.trim() || !text.trim() || (kind === "skill" && !description.trim())
            }
          >
            Publish to team
          </Button>
          <p className="text-xs text-muted-foreground">
            Each new note gets its own file. Automatic capture from agent conversations is not
            enabled yet.
          </p>
        </form>
      ) : null}
      {managedFiles.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border px-3">
          {managedFiles.map((file) => (
            <li key={file.id} className="py-2">
              <button
                type="button"
                disabled={busy}
                className="w-full break-all text-left text-xs text-primary underline-offset-4 hover:underline disabled:opacity-50"
                onClick={() => void run({ action: "read-file", teamId, path: file.path })}
              >
                {file.summary?.title ? (
                  <>
                    {file.summary.title}
                    <span className="block text-muted-foreground">{file.path}</span>
                  </>
                ) : (
                  file.path
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {document ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <p className="break-all text-xs text-muted-foreground">{document.path}</p>
          <label className="block space-y-1 text-xs">
            Document content
            <Textarea
              aria-label="Shared document content"
              className="min-h-64"
              value={edit}
              readOnly={!canWrite}
              disabled={busy}
              onChange={(event) => setEdit(event.target.value)}
              maxLength={60000}
            />
          </label>
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              {canWrite ? (
                <Button
                  disabled={busy || edit === document.text || !edit.trim()}
                  onClick={() =>
                    void run({
                      action: "update-file",
                      teamId,
                      path: document.path,
                      etag: document.etag,
                      text: edit,
                    })
                  }
                >
                  Save changes
                </Button>
              ) : null}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ action: "read-file", teamId, path: document.path })}
              >
                Reload document
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(!confirmDelete)}
              >
                Remove document
              </Button>
              {confirmDelete ? (
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void run({
                      action: "delete-file",
                      teamId,
                      path: document.path,
                      etag: document.etag,
                    })
                  }
                >
                  Confirm removal from team
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
