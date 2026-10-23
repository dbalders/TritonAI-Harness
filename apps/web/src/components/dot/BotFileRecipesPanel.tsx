import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { BotWaitingStatus } from "./BotWaitingStatus";
import type { DotApproval, DotTask } from "./dotClient";
import { usableWaiting, type DotWaitingAction } from "./dotWaiting";
import {
  fileRecipeBlockedText,
  fileRecipeEventLabel,
  fileRecipeEventProgress,
  fileRecipeReadSummary,
  safeRecipeLink,
  type DotFileRecipe,
  type DotFileRecipeAction,
  type DotFileRecipeEvent,
  type DotFileRecipeInput,
  type DotRecipeFolderListing,
} from "./dotFileRecipes";

export interface BotFileRecipesPanelProps {
  readonly recipes: readonly DotFileRecipe[];
  readonly approvals: readonly DotApproval[];
  readonly tasks: readonly DotTask[];
  /** Whether OneDrive read access is connected, from capability discovery; undefined when unknown. */
  readonly oneDriveConnected?: boolean | undefined;
  readonly onBrowse: (folderId?: string) => Promise<DotRecipeFolderListing>;
  readonly onCreate: (
    input: DotFileRecipeInput & { readonly folderId: string },
  ) => Promise<unknown>;
  readonly onEdit: (recipe: DotFileRecipe, input: DotFileRecipeInput) => Promise<unknown>;
  readonly onAction: (recipe: DotFileRecipe, action: DotFileRecipeAction) => Promise<unknown>;
  readonly onStart: (recipe: DotFileRecipe, event: DotFileRecipeEvent) => Promise<unknown>;
  /** Opens a file's decision or assignment (loading it when it is outside the snapshot), or another recovery. */
  readonly onWaitingAction?: ((action: DotWaitingAction) => void) | undefined;
}

const SHOWN_EVENTS = 10;

function timestamp(value: string | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Not available";
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function FolderPicker({
  onBrowse,
  onChoose,
  disabled,
}: {
  readonly onBrowse: BotFileRecipesPanelProps["onBrowse"];
  readonly onChoose: (folder: DotRecipeFolderListing["folder"]) => void;
  readonly disabled: boolean;
}) {
  const [trail, setTrail] = useState<DotRecipeFolderListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const current = trail.at(-1);
  const open = async (folderId?: string) => {
    setLoading(true);
    setError(null);
    await (async () => {
      try {
        const listing = await onBrowse(folderId);
        setTrail((previous) => (folderId ? [...previous, listing] : [listing]));
      } catch (cause) {
        setError(errorText(cause, "Could not open this OneDrive folder."));
      }
    })().finally(() => {
      setLoading(false);
    });
  };
  const loaded = useRef(false);
  useEffect(() => {
    // Load the drive root once when the picker opens.
    if (loaded.current) return;
    loaded.current = true;
    void open();
  });
  return (
    <fieldset className="space-y-2 rounded border p-2" aria-label="OneDrive folder">
      <legend>OneDrive folder</legend>
      {loading && <p role="status">Loading folders…</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      {current && (
        <>
          <p className="break-words text-xs text-muted-foreground">
            {trail.map((item) => item.folder.name).join(" / ")} · {current.files} files here
          </p>
          {current.note && <p className="text-xs text-muted-foreground">{current.note}</p>}
          <div className="flex flex-wrap gap-2">
            {trail.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || loading}
                onClick={() => setTrail((previous) => previous.slice(0, -1))}
              >
                Up one level
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || loading || !current.complete || trail.length < 2}
              onClick={() => onChoose(current.folder)}
            >
              Use “{current.folder.name}”
            </Button>
          </div>
          {current.subfolders.length === 0 ? (
            <p className="text-xs text-muted-foreground">No subfolders.</p>
          ) : (
            <ul className="space-y-1" aria-label="Subfolders">
              {current.subfolders.map((folder) => (
                <li key={folder.folderId}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || loading}
                    onClick={() => void open(folder.folderId)}
                  >
                    Open {folder.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </fieldset>
  );
}

function RecipeEditor({
  recipe,
  onBrowse,
  onSubmit,
  onCancel,
}: {
  readonly recipe?: DotFileRecipe | undefined;
  readonly onBrowse: BotFileRecipesPanelProps["onBrowse"];
  readonly onSubmit: (input: DotFileRecipeInput, folderId?: string) => Promise<unknown>;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState(recipe?.name ?? "");
  const [instructions, setInstructions] = useState(recipe?.instructions ?? "");
  const [expectedOutput, setExpectedOutput] = useState(recipe?.expectedOutput ?? "");
  const [approval, setApproval] = useState<DotFileRecipeInput["approval"]>(
    recipe?.approval ?? "ask",
  );
  const [folder, setFolder] = useState<DotRecipeFolderListing["folder"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    if (!recipe && !folder) {
      setError("Choose the OneDrive folder this recipe should watch.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    await (async () => {
      try {
        await onSubmit(
          {
            name: name.trim(),
            instructions: instructions.trim(),
            expectedOutput: expectedOutput.trim(),
            approval,
          },
          folder?.folderId,
        );
        onCancel();
      } catch (cause) {
        setError(errorText(cause, "Could not save this file recipe."));
      }
    })().finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  };
  return (
    <form
      aria-label={recipe ? "Edit file recipe" : "Create file recipe"}
      className="space-y-3 rounded-lg border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="font-semibold">{recipe ? `Edit ${recipe.name}` : "New file recipe"}</h3>
      <p className="text-xs text-muted-foreground">
        When a new file arrives directly in the chosen folder and stops changing, your bot prepares
        one Harness assignment with the file's text. Files already in the folder are never started.
        Supported: text, Markdown, CSV, JSON, XML, YAML, Word and text-based PDF files up to 4 MiB.
      </p>
      <label className="block space-y-1">
        Name
        <Input
          nativeInput
          aria-label="File recipe name"
          required
          maxLength={80}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      {recipe ? (
        <p className="text-xs text-muted-foreground">
          Folder: {recipe.folder.name}. To watch another folder, create a new recipe.
        </p>
      ) : folder ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Folder: {folder.name}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setFolder(null)}
          >
            Choose another folder
          </Button>
        </div>
      ) : (
        <FolderPicker onBrowse={onBrowse} onChoose={setFolder} disabled={busy} />
      )}
      <label className="block space-y-1">
        For each new file
        <Textarea
          aria-label="File recipe instructions"
          required
          maxLength={2000}
          value={instructions}
          disabled={busy}
          onChange={(event) => setInstructions(event.currentTarget.value)}
        />
      </label>
      <label className="block space-y-1">
        Expected result
        <Textarea
          aria-label="File recipe expected result"
          required
          maxLength={1000}
          value={expectedOutput}
          disabled={busy}
          onChange={(event) => setExpectedOutput(event.currentTarget.value)}
        />
      </label>
      <label className="block space-y-1">
        Before work starts
        <select
          aria-label="File recipe approval"
          className="w-full rounded border bg-background p-2"
          value={approval}
          disabled={busy}
          onChange={(event) => setApproval(event.target.value as DotFileRecipeInput["approval"])}
        >
          <option value="ask">Ask me for each file</option>
          <option value="review">Use my Harness task rule and the automatic review</option>
        </select>
      </label>
      {recipe && (
        <p className="text-xs text-muted-foreground">
          Changing what the recipe does means drafted work from the old instructions won't start.
          Files still settling continue with the new instructions.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : recipe ? "Save changes" : "Create recipe"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EventRow({
  event,
  recipe,
  approvals,
  tasks,
  onStart,
  onWaitingAction,
}: {
  readonly event: DotFileRecipeEvent;
  readonly recipe: DotFileRecipe;
  readonly approvals: readonly DotApproval[];
  readonly tasks: readonly DotTask[];
  readonly onStart: BotFileRecipesPanelProps["onStart"];
  readonly onWaitingAction: BotFileRecipesPanelProps["onWaitingAction"];
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = safeRecipeLink(event.version.webUrl);
  // The service reads the file's run, decision and assignment; older services fall back to this snapshot's records.
  const waiting = usableWaiting(event.waiting);
  const progress = waiting ? undefined : fileRecipeEventProgress(event, approvals, tasks);
  const read = fileRecipeReadSummary(event);
  const open: DotWaitingAction | undefined = event.taskId
    ? { kind: "open", label: "Open the assignment", target: { kind: "task", id: event.taskId } }
    : event.approvalId && event.status === "needs-decision"
      ? {
          kind: "open",
          label: "Open the decision",
          target: { kind: "approval", id: event.approvalId },
        }
      : undefined;
  return (
    <li className="space-y-1 border-t pt-1">
      <div className="flex flex-wrap items-center gap-2">
        {link ? (
          <a className="break-words underline" href={link} target="_blank" rel="noreferrer">
            {event.version.name}
          </a>
        ) : (
          <span className="break-words">{event.version.name}</span>
        )}
        <Badge variant="outline">{fileRecipeEventLabel(event)}</Badge>
        {event.manual && <Badge variant="outline">Started by you</Badge>}
        {!event.current && <Badge variant="outline">Earlier settings</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">Seen {timestamp(event.seenAt)}</p>
      {event.reason && <p className="text-xs text-muted-foreground">{event.reason}</p>}
      {waiting && (
        <BotWaitingStatus
          waiting={waiting}
          subject={event.version.name}
          onAction={onWaitingAction}
          canAct={() => onWaitingAction !== undefined}
        />
      )}
      {progress && <p className="text-xs text-muted-foreground">{progress}</p>}
      {/* Without a waiting status (older services, finished files) the row still opens its own linked record. */}
      {!waiting && open && onWaitingAction && (
        <Button variant="outline" size="xs" onClick={() => onWaitingAction(open)}>
          {open.label}
        </Button>
      )}
      {read && <p className="text-xs text-muted-foreground">{read}</p>}
      {event.startable && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setMessage(null);
            setError(null);
            onStart(recipe, event)
              .then(() => setMessage("Started. It reads the file's current version."))
              .catch((cause: unknown) => setError(errorText(cause, "Could not start this file.")))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Starting…" : "Start"}
        </Button>
      )}
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
    </li>
  );
}

const PAUSED = {
  owner: "Paused by you. No checks until you resume it.",
  "connection-changed":
    "Paused because your Microsoft connection changed. Resume it to keep checking this folder with the current connection.",
  "folder-unavailable": "Paused because the folder is no longer available.",
} as const;

function RecipeRow({
  recipe,
  approvals,
  tasks,
  onEdit,
  onAction,
  onStart,
  onWaitingAction,
}: {
  readonly recipe: DotFileRecipe;
  readonly approvals: readonly DotApproval[];
  readonly tasks: readonly DotTask[];
  readonly onEdit: () => void;
  readonly onAction: BotFileRecipesPanelProps["onAction"];
  readonly onStart: BotFileRecipesPanelProps["onStart"];
  readonly onWaitingAction: BotFileRecipesPanelProps["onWaitingAction"];
}) {
  const [busy, setBusy] = useState<DotFileRecipeAction | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const stopButton = useRef<HTMLButtonElement>(null);
  const live = recipe.status !== "stopped";
  const act = async (action: DotFileRecipeAction) => {
    setBusy(action);
    setMessage(null);
    setError(null);
    await (async () => {
      try {
        await onAction(recipe, action);
        setMessage(
          action === "pause"
            ? "Paused. Files that had not started won't start."
            : action === "resume"
              ? "Resumed. Files that arrived while paused are listed, not started."
              : "Stopped. Past files remain listed.",
        );
        if (action === "stop") setConfirmStop(false);
      } catch (cause) {
        setError(errorText(cause, "Could not update this file recipe."));
      }
    })().finally(() => {
      setBusy(null);
    });
  };
  const folderLink = safeRecipeLink(recipe.folder.webUrl);
  const waiting = usableWaiting(recipe.waiting);
  const events = showAll ? recipe.events : recipe.events.slice(0, SHOWN_EVENTS);
  return (
    <li id={`bot-file-recipe-${recipe.recipeId}`} tabIndex={-1} className="space-y-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="break-words font-medium">{recipe.name}</h4>
        <Badge variant="outline">
          {recipe.status === "active"
            ? "Active"
            : recipe.status === "paused"
              ? "Paused"
              : "Stopped"}
        </Badge>
        {(recipe.lastError || recipe.blocked) && <Badge variant="warning">Needs attention</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">
        New files in{" "}
        {folderLink ? (
          <a className="underline" href={folderLink} target="_blank" rel="noreferrer">
            {recipe.folder.name}
          </a>
        ) : (
          recipe.folder.name
        )}{" "}
        · {recipe.cadence} ·{" "}
        {recipe.approval === "ask"
          ? "asks you for each file"
          : "uses your Harness task rule and the automatic review"}
      </p>
      <p className="whitespace-pre-wrap break-words">{recipe.instructions}</p>
      <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
        Expected result: {recipe.expectedOutput}
      </p>
      {waiting ? (
        <BotWaitingStatus
          waiting={waiting}
          subject={recipe.name}
          onAction={(action) =>
            action.kind === "resume-recipe" ? void act("resume") : onWaitingAction?.(action)
          }
          canAct={(action) =>
            action.kind === "resume-recipe" ? busy === null : onWaitingAction !== undefined
          }
        />
      ) : (
        recipe.status === "paused" && (
          <p className="text-xs text-muted-foreground">{PAUSED[recipe.pausedReason ?? "owner"]}</p>
        )
      )}
      <dl className="space-y-1 text-xs text-muted-foreground">
        <div>
          <dt className="inline">Coverage: </dt>
          <dd className="inline">
            {!recipe.coverage
              ? "Not checked yet"
              : recipe.coverage.complete
                ? `All ${recipe.coverage.files} files directly in this folder were checked ${timestamp(recipe.coverage.checkedAt)}. Subfolders are not checked.`
                : "Incomplete: the folder has more than 100 items, so new files can't be detected reliably."}
          </dd>
        </div>
        <div>
          <dt className="inline">Last successful check: </dt>
          <dd className="inline">
            {recipe.lastSuccessAt ? timestamp(recipe.lastSuccessAt) : "No successful check yet"}
          </dd>
        </div>
        {!waiting && (
          <div>
            <dt className="inline">Next check: </dt>
            <dd className="inline">
              {recipe.status === "active" ? timestamp(recipe.nextCheckAt) : "Not scheduled"}
            </dd>
          </div>
        )}
        {recipe.lastError && (
          <div>
            <dt className="inline">Problem: </dt>
            <dd className="inline break-words">{recipe.lastError}</dd>
          </div>
        )}
      </dl>
      {recipe.blocked && waiting?.code !== "recipe-full" && (
        <p role="status" className="text-xs text-muted-foreground">
          {fileRecipeBlockedText(recipe.blocked)}
        </p>
      )}
      {recipe.coverage?.notListed ? (
        <p className="text-xs text-muted-foreground">
          {recipe.coverage.notListed} more files arrived during a gap in checking and were not
          started or listed. Copy one into the folder again to process it.
        </p>
      ) : null}
      {live && (
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={`Actions for ${recipe.name}`}
        >
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={onEdit}>
            Edit recipe
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => void act(recipe.status === "active" ? "pause" : "resume")}
          >
            {busy === "pause" || busy === "resume"
              ? "Updating…"
              : recipe.status === "active"
                ? "Pause"
                : "Resume"}
          </Button>
          <Button
            ref={stopButton}
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setError(null);
              setConfirmStop(true);
            }}
          >
            Stop
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
      {error && !confirmStop && (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      )}
      <section aria-label={`Files for ${recipe.name}`}>
        <h5 className="text-xs font-semibold">Files</h5>
        {recipe.events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No new files yet.</p>
        ) : (
          <ul className="space-y-1">
            {events.map((event) => (
              <EventRow
                key={event.key}
                event={event}
                recipe={recipe}
                approvals={approvals}
                tasks={tasks}
                onStart={onStart}
                onWaitingAction={onWaitingAction}
              />
            ))}
          </ul>
        )}
        {recipe.events.length > SHOWN_EVENTS && (
          <Button variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "Show fewer" : `Show all ${recipe.events.length} files`}
          </Button>
        )}
      </section>
      <AlertDialog
        open={confirmStop}
        onOpenChange={(open) => {
          if (!open && busy === null) {
            setConfirmStop(false);
            stopButton.current?.focus();
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop “{recipe.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              New files are no longer checked. Files that have not started won't start, and drafted
              decisions can only be declined. Work already running is not recalled.
            </AlertDialogDescription>
            {error && (
              <p role="alert" className="text-sm text-destructive-foreground">
                {error}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy !== null} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy !== null} onClick={() => void act("stop")}>
              {busy === "stop" ? "Stopping…" : "Stop recipe"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

export function BotFileRecipesPanel({
  recipes,
  approvals,
  tasks,
  oneDriveConnected,
  onBrowse,
  onCreate,
  onEdit,
  onAction,
  onStart,
  onWaitingAction,
}: BotFileRecipesPanelProps) {
  const [editing, setEditing] = useState<DotFileRecipe | "new" | null>(null);
  const current =
    editing && editing !== "new"
      ? recipes.find((item) => item.recipeId === editing.recipeId)
      : undefined;
  const changed = editing && editing !== "new" && current?.generation !== editing.generation;
  return (
    <details className="shrink-0 rounded-xl border px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">File recipes</summary>
      <div className="mt-2 space-y-3 text-sm">
        {oneDriveConnected === false ? (
          <p role="status" className="text-xs text-muted-foreground">
            Connect OneDrive read access in your bot's Microsoft connection settings to create a
            file recipe.
          </p>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
            New file recipe
          </Button>
        )}
        {editing &&
          (changed ? (
            <div role="alert">
              <p>This recipe changed. Close the editor and review its latest version.</p>
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Close editor
              </Button>
            </div>
          ) : (
            <RecipeEditor
              key={editing === "new" ? "new" : `${editing.recipeId}:${editing.generation}`}
              recipe={editing === "new" ? undefined : editing}
              onBrowse={onBrowse}
              onSubmit={(input, folderId) =>
                editing === "new"
                  ? onCreate({ ...input, folderId: folderId! })
                  : onEdit(editing, input)
              }
              onCancel={() => setEditing(null)}
            />
          ))}
        {recipes.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No file recipes yet. A recipe turns each new file in one OneDrive folder into a Harness
            assignment, with your approval.
          </p>
        ) : (
          <ul className="space-y-3">
            {recipes.map((recipe) => (
              <RecipeRow
                key={recipe.recipeId}
                recipe={recipe}
                approvals={approvals}
                tasks={tasks}
                onEdit={() => setEditing(recipe)}
                onAction={onAction}
                onStart={onStart}
                onWaitingAction={onWaitingAction}
              />
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
