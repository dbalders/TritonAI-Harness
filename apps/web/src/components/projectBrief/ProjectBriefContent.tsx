import {
  MessageId,
  ThreadId,
  type ProjectBriefCommand,
  type ProjectBriefProposal,
  type ProjectBriefState,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { ArrowUpRightIcon, CheckIcon, FileTextIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import {
  projectBriefExecutionLabel,
  projectBriefCanArchive,
  projectBriefSafeSourceUrl,
  projectBriefSourcesChanged,
} from "./projectBriefView";

type ActionWithoutEnvelope<T> = T extends ProjectBriefCommand
  ? Omit<T, "requestId" | "projectId" | "expectedRevision">
  : never;
export type ProjectBriefAction = ActionWithoutEnvelope<ProjectBriefCommand>;
export type RunBriefAction = (action: ProjectBriefAction) => Promise<boolean>;

type MessagePicker = (onSelect: (threadId: string, messageId: string) => void) => ReactNode;

function SourceForm({
  run,
  disabled,
  onClose,
  renderMessagePicker,
}: {
  run: RunBriefAction;
  disabled: boolean;
  onClose: () => void;
  renderMessagePicker?: MessagePicker;
}) {
  const [kind, setKind] = useState<"file" | "message" | "excerpt">("file");
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [threadId, setThreadId] = useState("");
  const [messageId, setMessageId] = useState("");
  const valid =
    kind === "file"
      ? path.trim().length > 0
      : kind === "excerpt"
        ? title.trim().length > 0 &&
          text.trim().length > 0 &&
          (!url.trim() || projectBriefSafeSourceUrl(url.trim()) !== null)
        : threadId.trim().length > 0 && messageId.trim().length > 0;
  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !valid) return;
        const source =
          kind === "file"
            ? { kind, relativePath: path.trim() }
            : kind === "excerpt"
              ? {
                  kind,
                  title: title.trim(),
                  text: text.trim(),
                  ...(url.trim() ? { url: url.trim() } : {}),
                }
              : {
                  kind,
                  threadId: ThreadId.make(threadId.trim()),
                  messageId: MessageId.make(messageId.trim()),
                };
        void run({ action: "addSource", source }).then((ok) => {
          if (ok) onClose();
        });
      }}
    >
      <label className="block space-y-1.5 text-xs font-medium">
        <span>Source type</span>
        <select
          aria-label="Source type"
          value={kind}
          disabled={disabled}
          onChange={(event) => setKind(event.target.value as typeof kind)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="file">Project file</option>
          <option value="excerpt">Pasted excerpt</option>
          <option value="message">Harness message</option>
        </select>
      </label>
      {kind === "file" ? (
        <>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Path within this project</span>
            <Input
              aria-label="Path within this project"
              placeholder="docs/project-notes.md"
              value={path}
              maxLength={300}
              disabled={disabled}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Choose a text file from this project. Only the selected file becomes a source.
          </p>
        </>
      ) : kind === "excerpt" ? (
        <>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Title</span>
            <Input
              aria-label="Source title"
              value={title}
              maxLength={300}
              disabled={disabled}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Excerpt</span>
            <Textarea
              aria-label="Source excerpt"
              value={text}
              maxLength={32000}
              disabled={disabled}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Original URL (optional)</span>
            <Input
              aria-label="Original source URL"
              type="url"
              value={url}
              maxLength={2000}
              disabled={disabled}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The excerpt is saved as written. Its URL is a reference; the page is not imported or
            refreshed.
          </p>
        </>
      ) : renderMessagePicker ? (
        renderMessagePicker((thread, message) => {
          setThreadId(thread);
          setMessageId(message);
        })
      ) : (
        <>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Thread ID</span>
            <Input
              aria-label="Source thread ID"
              value={threadId}
              disabled={disabled}
              onChange={(event) => setThreadId(event.target.value)}
            />
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>Message ID</span>
            <Input
              aria-label="Source message ID"
              value={messageId}
              disabled={disabled}
              onChange={(event) => setMessageId(event.target.value)}
            />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Select one message from a thread in this project. The rest of the conversation is not
            included.
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={disabled || !valid}>
          Add source
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Evidence({
  proposal,
  state,
  expanded = false,
}: {
  proposal: ProjectBriefProposal;
  state: ProjectBriefState;
  expanded?: boolean;
}) {
  return (
    <details className="text-xs" open={expanded}>
      <summary className="cursor-pointer py-1 text-muted-foreground focus-visible:outline focus-visible:outline-ring">
        Supporting sources · {proposal.citations.length}
      </summary>
      <div className="mt-2 space-y-3">
        {proposal.citations
          .filter(
            (citation, index, entries) =>
              entries.findIndex(
                (entry) =>
                  entry.snapshotId === citation.snapshotId && entry.quote === citation.quote,
              ) === index,
          )
          .map((citation) => {
            const snapshot = state.snapshots.find((item) => item.id === citation.snapshotId);
            return (
              <blockquote
                key={`${citation.snapshotId}:${citation.quote}`}
                className="border-l-2 border-border pl-3"
              >
                <p className="font-medium">{snapshot?.title ?? "Source unavailable"}</p>
                <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-muted-foreground">
                  {citation.quote}
                </p>
              </blockquote>
            );
          })}
      </div>
    </details>
  );
}

function ProposalEditor({
  proposal,
  run,
  disabled,
  close,
}: {
  proposal: ProjectBriefProposal;
  run: RunBriefAction;
  disabled: boolean;
  close: () => void;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [body, setBody] = useState(proposal.body);
  const [criteria, setCriteria] = useState(proposal.completionCriteria);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !title.trim() || !body.trim() || !criteria.trim()) return;
        void run({
          action: "edit",
          proposalId: proposal.id,
          title: title.trim(),
          body: body.trim(),
          completionCriteria: criteria.trim(),
        }).then((ok) => {
          if (ok) close();
        });
      }}
    >
      <label className="block space-y-1 text-xs">
        <span>Title</span>
        <Input
          aria-label="Proposal title"
          value={title}
          maxLength={300}
          disabled={disabled}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="block space-y-1 text-xs">
        <span>Proposal</span>
        <Textarea
          aria-label="Proposal text"
          value={body}
          maxLength={32000}
          disabled={disabled}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      <label className="block space-y-1 text-xs">
        <span>What would count as done?</span>
        <Textarea
          aria-label="Completion criteria"
          value={criteria}
          maxLength={32000}
          disabled={disabled}
          onChange={(event) => setCriteria(event.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Saving edits returns this item to review and keeps its supporting sources.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={disabled || !title.trim() || !body.trim() || !criteria.trim()}
        >
          Save proposal
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ProjectBriefContent({
  state,
  busy,
  canWrite,
  error,
  run,
  modelControl,
  modelReady,
  openThread,
  renderMessagePicker,
  openArchive,
}: {
  state: ProjectBriefState;
  busy: boolean;
  canWrite: boolean;
  error: string | null;
  run: RunBriefAction;
  modelControl: ReactNode;
  modelReady: boolean;
  openThread: (threadId: ThreadId) => void;
  renderMessagePicker?: MessagePicker;
  openArchive?: (archiveId: string) => void;
}) {
  const [addingSource, setAddingSource] = useState(false);
  const [editing, setEditing] = useState<{ id: string; digest: string } | null>(null);
  const [launchReview, setLaunchReview] = useState<{ id: string; digest: string } | null>(null);
  const [resultReview, setResultReview] = useState<{ id: string; digest: string } | null>(null);
  const [withdrawReview, setWithdrawReview] = useState<{ id: string; revision: number } | null>(
    null,
  );
  const [discardGenerationId, setDiscardGenerationId] = useState<string | null>(null);
  const [archiveReviewRevision, setArchiveReviewRevision] = useState<number | null>(null);
  const disabled = busy || !canWrite;
  const canArchive = projectBriefCanArchive(state);
  const stale = projectBriefSourcesChanged(state);
  const sourcesReady =
    state.sources.length > 0 && state.sources.every((source) => source.status === "available");
  const generating =
    state.synthesis?.status === "running" || state.synthesis?.status === "dispatch-pending";
  const proposals = state.proposals.filter((proposal) => proposal.status !== "superseded");
  const dismissed = proposals.filter((proposal) => proposal.status === "dismissed");
  const visible = proposals.filter((proposal) => proposal.status !== "dismissed");
  return (
    <>
      {error ? (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      {!canWrite ? (
        <p
          role="status"
          className="mb-5 rounded-lg border border-border p-3 text-sm text-muted-foreground"
        >
          You can read this brief. Editing sources or starting work requires permission in this
          environment.
        </p>
      ) : null}
      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-10">
        <aside
          className="min-w-0 space-y-4 lg:col-start-2 lg:row-start-1"
          aria-labelledby="brief-sources-title"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 id="brief-sources-title" className="text-sm font-semibold">
              Sources{" "}
              <span className="ml-1 font-normal text-muted-foreground">{state.sources.length}</span>
            </h2>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setAddingSource(true)}
            >
              <PlusIcon className="size-3.5" />
              Add
            </Button>
          </div>
          {addingSource ? (
            <SourceForm
              run={run}
              disabled={disabled}
              onClose={() => setAddingSource(false)}
              {...(renderMessagePicker ? { renderMessagePicker } : {})}
            />
          ) : null}
          {state.sources.length === 0 ? (
            <p className="text-sm leading-relaxed text-muted-foreground">
              Choose the notes, files or messages this brief should use. You control what is
              included.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {state.sources.map((source) => {
                const snapshot = state.snapshots.find((item) => item.id === source.snapshotId);
                const url = projectBriefSafeSourceUrl(snapshot?.url);
                return (
                  <li key={source.id} className="py-3 first:pt-0">
                    <details>
                      <summary className="cursor-pointer break-words text-sm font-medium leading-relaxed focus-visible:outline focus-visible:outline-ring">
                        {snapshot?.title ??
                          (source.selection.kind === "file"
                            ? source.selection.relativePath
                            : "Selected message")}
                      </summary>
                      {source.status === "available" && snapshot ? (
                        <div className="mt-2 space-y-2">
                          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                            {snapshot.text}
                          </p>
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs underline underline-offset-4"
                            >
                              Original source
                              <ArrowUpRightIcon className="size-3" />
                            </a>
                          ) : null}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-destructive">
                          This source is unavailable. Restore access or remove it before generating
                          a brief.
                        </p>
                      )}
                    </details>
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {source.status === "available" && snapshot
                          ? `Read ${new Date(snapshot.capturedAt).toLocaleString()}`
                          : "Unavailable"}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={disabled || generating}
                        onClick={() => void run({ action: "removeSource", sourceId: source.id })}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {state.sources.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || generating}
              onClick={() => void run({ action: "refresh" })}
            >
              <RefreshCwIcon className="size-3.5" />
              Refresh sources & work
            </Button>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Only these selected sources are used. A URL on a pasted excerpt does not grant access to
            its contents.
          </p>
        </aside>
        <div className="min-w-0 space-y-8 lg:col-start-1 lg:row-start-1">
          <section aria-labelledby="brief-overview-title" className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="brief-overview-title" className="text-sm font-semibold">
                  Brief
                </h2>
                {state.brief ? (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <p className="text-xs text-muted-foreground">
                      Updated {new Date(state.brief.generatedAt).toLocaleString()}
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => state.brief && openThread(state.brief.threadId)}
                    >
                      Open brief thread
                    </Button>
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {modelControl}
                <Button
                  size="sm"
                  disabled={
                    disabled ||
                    !sourcesReady ||
                    generating ||
                    state.synthesis?.status === "uncertain" ||
                    !modelReady
                  }
                  onClick={() => void run({ action: "generate" })}
                >
                  {generating
                    ? "Preparing brief…"
                    : state.brief
                      ? "Generate new proposal"
                      : "Generate brief"}
                </Button>
              </div>
            </div>
            {stale ? (
              <p
                role="status"
                className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm"
              >
                Sources changed since this brief. Generate a new proposal before accepting or
                starting work.
              </p>
            ) : null}
            {generating ? (
              <p role="status" className="text-sm text-muted-foreground">
                An agent is reading your selected sources. The existing brief stays available.
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => state.synthesis && openThread(state.synthesis.threadId)}
                >
                  Open thread
                </Button>
              </p>
            ) : null}
            {state.synthesis && ["failed", "uncertain"].includes(state.synthesis.status) ? (
              <div role="alert" className="space-y-2 text-sm text-destructive">
                <p>The brief did not finish. Check its thread before trying again.</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => state.synthesis && openThread(state.synthesis.threadId)}
                >
                  Inspect brief thread
                </Button>
              </div>
            ) : null}
            {state.synthesis &&
            ["uncertain", "dispatch-pending"].includes(state.synthesis.status) ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  If startup was interrupted, retry the same brief thread without creating another.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void run({ action: "retry" })}
                >
                  Retry starting brief thread
                </Button>
              </div>
            ) : null}
            {state.synthesis &&
            ["dispatch-pending", "running", "uncertain", "failed", "published"].includes(
              state.synthesis.status,
            ) ? (
              <div className="space-y-3">
                {discardGenerationId === null ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => setDiscardGenerationId(state.synthesis!.id)}
                  >
                    Discard this generation
                  </Button>
                ) : (
                  <div
                    role="region"
                    aria-label="Discard generation confirmation"
                    className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
                  >
                    <h3 className="text-sm font-medium">Discard this generation?</h3>
                    <p className="text-sm leading-6">
                      Late results from this generation will no longer update the brief. Its
                      original thread may still be running; open that thread if you also want to
                      stop it.
                    </p>
                    {discardGenerationId !== state.synthesis.id ? (
                      <p role="alert" className="text-sm text-destructive">
                        A different generation is now active. Cancel this confirmation and review
                        the current generation.
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={disabled || discardGenerationId !== state.synthesis.id}
                        onClick={() =>
                          void run({
                            action: "discardGeneration",
                            synthesisId: discardGenerationId,
                          }).then((ok) => {
                            if (ok) setDiscardGenerationId(null);
                          })
                        }
                      >
                        Confirm discard
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDiscardGenerationId(null)}
                      >
                        Keep generation
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => state.synthesis && openThread(state.synthesis.threadId)}
                      >
                        Open original thread
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
            {state.synthesis?.status === "superseded" ? (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>This generation was discarded. You can generate a new brief.</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => state.synthesis && openThread(state.synthesis.threadId)}
                >
                  Open original thread
                </Button>
              </div>
            ) : null}
            {state.brief ? (
              <p className="whitespace-pre-wrap break-words text-sm leading-7">
                {state.brief.summary}
              </p>
            ) : (
              <div className="rounded-xl border border-dashed border-border px-5 py-8">
                <FileTextIcon className="mb-3 size-6 text-muted-foreground" />
                <h3 className="text-base font-medium">
                  A clear next step, grounded in your project.
                </h3>
                <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
                  Add a few relevant sources, then generate a brief. Review the suggested decisions
                  and actions before any work starts.
                </p>
                {!addingSource && state.sources.length === 0 ? (
                  <div className="mt-4">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => setAddingSource(true)}
                    >
                      Choose sources
                    </Button>
                  </div>
                ) : null}
              </div>
            )}
          </section>
          {visible.length > 0 ? (
            <section aria-labelledby="brief-proposals-title">
              <h2 id="brief-proposals-title" className="mb-2 text-sm font-semibold">
                Decisions & next steps
              </h2>
              <div className="divide-y divide-border">
                {visible.map((proposal) => {
                  const proposalStale = stale || proposal.sourceDigest !== state.sourceDigest;
                  const executions = state.executions.filter(
                    (execution) => execution.proposalId === proposal.id,
                  );
                  const launched = executions.length > 0;
                  const reviewOpen = launchReview?.id === proposal.id;
                  const reviewedVersionChanged =
                    reviewOpen && launchReview.digest !== proposal.approvalDigest;
                  return (
                    <article key={proposal.id} className="space-y-3 py-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          {proposal.kind === "decision" ? "Decision" : "Next step"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {proposalStale
                            ? "Sources changed"
                            : proposal.status === "accepted"
                              ? "Accepted"
                              : "Proposed for review"}
                        </span>
                      </div>
                      {editing?.id === proposal.id && editing.digest !== proposal.approvalDigest ? (
                        <p role="alert" className="text-sm text-destructive">
                          This proposal changed while you were editing. Your text is still here;
                          cancel and review the latest version before saving.
                        </p>
                      ) : null}
                      {editing?.id === proposal.id ? (
                        <ProposalEditor
                          key={proposal.id}
                          proposal={proposal}
                          run={run}
                          disabled={
                            disabled || proposalStale || editing.digest !== proposal.approvalDigest
                          }
                          close={() => setEditing(null)}
                        />
                      ) : (
                        <>
                          <h3 className="break-words text-base font-medium">{proposal.title}</h3>
                          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
                            {proposal.body}
                          </p>
                          <div className="text-sm leading-6">
                            <span className="font-medium">Done when </span>
                            {proposal.completionCriteria}
                          </div>
                        </>
                      )}
                      <Evidence proposal={proposal} state={state} expanded={reviewOpen} />
                      {!launched && editing?.id !== proposal.id ? (
                        <div className="flex flex-wrap gap-2">
                          {proposal.status === "proposed" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={disabled || proposalStale}
                              onClick={() =>
                                void run({
                                  action: "decide",
                                  proposalId: proposal.id,
                                  decision: "accept",
                                })
                              }
                            >
                              Accept {proposal.kind === "decision" ? "decision" : "next step"}
                            </Button>
                          ) : proposal.kind === "action" ? (
                            <Button
                              size="sm"
                              disabled={disabled || proposalStale || !modelReady}
                              onClick={() =>
                                setLaunchReview({
                                  id: proposal.id,
                                  digest: proposal.approvalDigest,
                                })
                              }
                            >
                              Review & start thread
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={disabled || proposalStale}
                              onClick={() =>
                                void run({
                                  action: "decide",
                                  proposalId: proposal.id,
                                  decision: "reopen",
                                })
                              }
                            >
                              Reopen decision
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={disabled || proposalStale}
                            onClick={() =>
                              setEditing({ id: proposal.id, digest: proposal.approvalDigest })
                            }
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={disabled || proposalStale}
                            onClick={() =>
                              void run({
                                action: "decide",
                                proposalId: proposal.id,
                                decision: "dismiss",
                              })
                            }
                          >
                            Dismiss
                          </Button>
                        </div>
                      ) : null}
                      {reviewOpen ? (
                        <div
                          className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
                          role="region"
                          aria-label={`Review launch: ${proposal.title}`}
                        >
                          <h4 className="text-sm font-semibold">Start this work in a new thread</h4>
                          <p className="text-sm leading-6">
                            The agent receives this action, its completion criteria and the cited
                            source versions above. The result will return here for your review.
                          </p>
                          {reviewedVersionChanged ? (
                            <p role="alert" className="text-sm text-destructive">
                              This proposal changed while you were reviewing it. Close this review
                              and check the updated proposal.
                            </p>
                          ) : null}
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              disabled={
                                disabled ||
                                proposalStale ||
                                reviewedVersionChanged ||
                                !modelReady ||
                                launched
                              }
                              onClick={() => {
                                if (launchReview)
                                  void run({
                                    action: "launch",
                                    proposalId: proposal.id,
                                    approvedDigest: launchReview.digest,
                                  }).then((ok) => {
                                    if (ok) setLaunchReview(null);
                                  });
                              }}
                            >
                              Start thread
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setLaunchReview(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}
          {state.brief && visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No proposed decisions or actions are waiting for review.
            </p>
          ) : null}
          {state.executions.length > 0 ? (
            <section aria-labelledby="brief-work-title">
              <h2 id="brief-work-title" className="mb-2 text-sm font-semibold">
                Work & returned results
              </h2>
              <div className="divide-y divide-border">
                {state.executions.map((execution) => {
                  const proposal = state.proposals.find((item) => item.id === execution.proposalId);
                  const reviewing = resultReview?.id === execution.id;
                  const resultChanged =
                    reviewing && resultReview.digest !== execution.result?.digest;
                  const withdrawable = ["uncertain", "dispatch-pending"].includes(execution.status);
                  const withdrawing = withdrawReview?.id === execution.id;
                  const withdrawChanged =
                    withdrawing && (withdrawReview.revision !== state.revision || !withdrawable);
                  const cancellable = [
                    "dispatch-pending",
                    "queued",
                    "running",
                    "uncertain",
                  ].includes(execution.status);
                  const canRevise = [
                    "needs-review",
                    "completed",
                    "failed",
                    "interrupted",
                    "cancelled",
                    "result-missing",
                  ].includes(execution.status);
                  return (
                    <article key={execution.id} className="space-y-3 py-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <h3 className="min-w-0 break-words text-sm font-medium">
                          {proposal?.title ?? "Project work"}
                        </h3>
                        <Badge
                          variant={
                            execution.status === "completed"
                              ? "success"
                              : execution.status === "needs-review"
                                ? "info"
                                : "outline"
                          }
                        >
                          {execution.status === "completed" ? (
                            <CheckIcon className="size-3" />
                          ) : null}
                          {execution.stopRequested && cancellable
                            ? "Stop requested"
                            : projectBriefExecutionLabel(execution.status)}
                        </Badge>
                      </div>
                      {execution.result ? (
                        <>
                          <p className="whitespace-pre-wrap break-words text-sm leading-6">
                            {execution.result.summary}
                          </p>
                          {execution.result.artifacts.length > 0 ? (
                            <div className="space-y-1">
                              <p className="text-xs font-medium text-muted-foreground">
                                Returned artifacts
                              </p>
                              <ul className="space-y-1">
                                {execution.result.artifacts.map((artifact) => (
                                  <li
                                    key={artifact.relativePath}
                                    className="break-all font-mono text-xs"
                                  >
                                    {artifact.relativePath}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          {execution.status === "result-missing"
                            ? "The thread finished without returning a verified result. Inspect the thread, then prepare a revision if more work is needed."
                            : execution.status === "withdrawn"
                              ? "Tracking was withdrawn. The original thread may still be running; inspect it before starting replacement work."
                              : "No result has returned yet. Open the thread to inspect its progress."}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openThread(execution.threadId)}
                        >
                          Open work thread
                          <ArrowUpRightIcon className="size-3.5" />
                        </Button>
                        {execution.status === "needs-review" && execution.result ? (
                          <Button
                            size="sm"
                            disabled={disabled}
                            onClick={() =>
                              setResultReview({
                                id: execution.id,
                                digest: execution.result!.digest,
                              })
                            }
                          >
                            Review result
                          </Button>
                        ) : null}
                        {cancellable ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={disabled}
                            onClick={() =>
                              void run({ action: "cancel", executionId: execution.id })
                            }
                          >
                            {execution.stopRequested ? "Retry stop" : "Stop work"}
                          </Button>
                        ) : null}
                        {!execution.stopRequested &&
                        ["uncertain", "dispatch-pending"].includes(execution.status) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => void run({ action: "retry", executionId: execution.id })}
                          >
                            Retry starting work thread
                          </Button>
                        ) : null}
                        {withdrawable && !withdrawing ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={disabled}
                            onClick={() =>
                              setWithdrawReview({ id: execution.id, revision: state.revision })
                            }
                          >
                            Withdraw tracking
                          </Button>
                        ) : null}
                        {execution.status === "completed" ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={disabled}
                            onClick={() =>
                              void run({ action: "reopenResult", executionId: execution.id })
                            }
                          >
                            Reopen review
                          </Button>
                        ) : null}
                        {canRevise && proposal ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={disabled || proposal.sourceDigest !== state.sourceDigest}
                            onClick={() => void run({ action: "revise", proposalId: proposal.id })}
                          >
                            {execution.status === "result-missing"
                              ? "Prepare revision"
                              : "Revise next step"}
                          </Button>
                        ) : null}
                      </div>
                      {withdrawing ? (
                        <div
                          role="region"
                          aria-label="Withdraw tracking confirmation"
                          className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
                        >
                          <h4 className="text-sm font-semibold">
                            Withdraw tracking for this work?
                          </h4>
                          <p className="text-sm leading-6">
                            This brief will stop retrying and accepting results from this work. Its
                            original thread may still be running. Open the work thread to inspect it
                            before withdrawing or starting replacement work.
                          </p>
                          <p className="text-xs leading-5 text-muted-foreground">
                            Withdrawal does not mark the work complete or confirm it has stopped.
                            Its record will remain available, and you can archive this brief once no
                            other work is active.
                          </p>
                          {withdrawChanged ? (
                            <p role="alert" className="text-sm text-destructive">
                              This brief changed while you were reviewing. Keep tracking, then
                              review the latest state before withdrawing.
                            </p>
                          ) : null}
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={disabled || withdrawChanged}
                              onClick={() =>
                                void run({
                                  action: "withdrawExecution",
                                  executionId: execution.id,
                                }).then((ok) => {
                                  if (ok) setWithdrawReview(null);
                                })
                              }
                            >
                              Confirm withdrawal
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setWithdrawReview(null)}
                            >
                              Keep tracking
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {reviewing ? (
                        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
                          <h4 className="text-sm font-semibold">
                            Does this meet the completion criteria?
                          </h4>
                          <p className="whitespace-pre-wrap text-sm leading-6">
                            {proposal?.completionCriteria}
                          </p>
                          <p className="text-xs leading-5 text-muted-foreground">
                            Check the returned artifacts in the work thread. Mark complete only
                            after you have reviewed the result.
                          </p>
                          {resultChanged ? (
                            <p role="alert" className="text-sm text-destructive">
                              The result changed. Close this review and inspect the latest result.
                            </p>
                          ) : null}
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              disabled={
                                disabled || resultChanged || execution.status !== "needs-review"
                              }
                              onClick={() => {
                                if (resultReview)
                                  void run({
                                    action: "review",
                                    executionId: execution.id,
                                    resultDigest: resultReview.digest,
                                  }).then((ok) => {
                                    if (ok) setResultReview(null);
                                  });
                              }}
                            >
                              Mark reviewed complete
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setResultReview(null)}>
                              Keep open
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}
          {dismissed.length > 0 ? (
            <details className="border-t border-border pt-4">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Dismissed proposals · {dismissed.length}
              </summary>
              <ul className="mt-3 space-y-2">
                {dismissed.map((proposal) => (
                  <li
                    key={proposal.id}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <span>{proposal.title}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled || proposal.sourceDigest !== state.sourceDigest}
                      onClick={() =>
                        void run({ action: "decide", proposalId: proposal.id, decision: "reopen" })
                      }
                    >
                      Reopen
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <section
            aria-labelledby="brief-history-title"
            className="space-y-4 border-t border-border pt-5"
          >
            <h2 id="brief-history-title" className="text-sm font-semibold">
              Saved briefs
            </h2>
            {(state.archives?.length ?? 0) > 0 ? (
              <ul className="divide-y divide-border">
                {state.archives?.map((archive) => (
                  <li
                    key={archive.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-3"
                  >
                    <div>
                      <p className="text-sm">{new Date(archive.archivedAt).toLocaleString()}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {archive.sourceCount} sources · {archive.proposalCount} proposals ·{" "}
                        {archive.executionCount} work items
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!openArchive}
                      onClick={() => openArchive?.(archive.id)}
                    >
                      Read saved brief
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                Finished briefs can be saved here before starting a new one.
              </p>
            )}
            {(state.archives?.length ?? 0) >= 20 ? (
              <p className="text-xs text-muted-foreground">Showing the latest 20 saved briefs.</p>
            ) : null}
            {state.sources.length > 0 ||
            state.proposals.length > 0 ||
            state.executions.length > 0 ||
            state.synthesis ? (
              <>
                {archiveReviewRevision === null ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || !canArchive}
                    onClick={() => setArchiveReviewRevision(state.revision)}
                  >
                    Archive & start fresh
                  </Button>
                ) : (
                  <div
                    role="region"
                    aria-label="Archive brief confirmation"
                    className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
                  >
                    <h3 className="text-sm font-medium">Save this brief and start fresh?</h3>
                    <p className="text-sm leading-6">
                      The current source versions, proposals and results will be preserved in a
                      read-only saved brief. The current brief will be cleared. Its threads stay
                      available.
                    </p>
                    {state.executions.some((execution) => execution.status === "needs-review") ? (
                      <p className="text-sm leading-6">
                        Unreviewed results will remain unreviewed in the saved brief. Complete those
                        reviews first if you want them marked complete.
                      </p>
                    ) : null}
                    {archiveReviewRevision !== state.revision ? (
                      <p role="alert" className="text-sm text-destructive">
                        This brief changed while you were reviewing. Keep it open, then review the
                        latest version before archiving.
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          disabled || !canArchive || archiveReviewRevision !== state.revision
                        }
                        onClick={() =>
                          void run({ action: "archive" }).then((ok) => {
                            if (ok) setArchiveReviewRevision(null);
                          })
                        }
                      >
                        Save brief & start fresh
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setArchiveReviewRevision(null)}
                      >
                        Keep current brief
                      </Button>
                    </div>
                  </div>
                )}
                {!canArchive ? (
                  <p className="text-xs leading-5 text-muted-foreground">
                    Finish or stop active work and discard any unfinished generation before
                    archiving.
                  </p>
                ) : null}
              </>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}
