import { Link } from "@tanstack/react-router";
import { BotIcon, SendIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import { cn, randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { clearBotSessions, useBotServiceUrl } from "./botService";
import { BotRunStatus } from "./BotRunStatus";
import { BotHandlingPanel } from "./BotHandlingPanel";
import { BotRoutinesPanel } from "./BotRoutinesPanel";
import { BotCapabilitiesPanel, BotMicrosoftBanner } from "./BotDiscoveryPanels";
import type { DotHandlingItem } from "./dotHandling";
import type { DotScheduledPrompt, DotScheduledPromptAction } from "./dotRoutines";
import {
  DOT_FEEDBACK_REASONS,
  DotApiError,
  taskComputerNotice,
  DotClient,
  draftAfterSend,
  isRateableRun,
  isPendingDotRun,
  readDotSession,
  runStatusLabel,
  saveDotSession,
  type DotFeedback,
  type DotFeedbackRating,
  type DotFeedbackReason,
  type DotQuality,
  type DotSession,
  type DotState,
  type PendingConnection,
  type PendingMessage,
} from "./dotClient";

const SIGNUPS_CLOSED = "TritonAI Bot isn't accepting new users right now.";

export function DotPage() {
  const serviceUrl = useBotServiceUrl();
  // Remount per address: sessions, pending sign-ins and polling never cross services.
  return serviceUrl ? (
    <BotWorkspace key={serviceUrl} serviceUrl={serviceUrl} />
  ) : (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden isolate">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-lg font-semibold">TritonAI Bot is off</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Add a TritonAI Bot service address in Settings to use your personal bot.
        </p>
        <Button variant="outline" render={<Link to="/settings/connections" />}>
          Open Connections settings
        </Button>
      </div>
    </SidebarInset>
  );
}

function BotWorkspace({ serviceUrl }: { readonly serviceUrl: string }) {
  const client = useMemo(() => new DotClient(serviceUrl), [serviceUrl]);
  const [session, setSession] = useState<DotSession | null>(() => {
    clearBotSessions(sessionStorage, serviceUrl);
    return readDotSession(sessionStorage, serviceUrl);
  });
  const [state, setState] = useState<DotState | null>(null);
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState<PendingConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const threadId = state?.streamId ?? "dot";
  const pendingPromptRuns = useRef(new Map<string, string>());
  const [busyPause, setBusyPause] = useState(false);
  const [busyMemory, setBusyMemory] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const [busyFeedback, setBusyFeedback] = useState<string | null>(null);
  const pendingMessage = useRef<PendingMessage | null>(null);
  const acceptedRunIds = useRef(new Set<string>());
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const activeOwner = useRef(session?.ownerToken);
  const mounted = useRef(true);

  const saveSession = useCallback(
    (value: DotSession | null) => {
      saveDotSession(sessionStorage, serviceUrl, value);
      const ownerChanged = activeOwner.current !== value?.ownerToken;
      activeOwner.current = value?.ownerToken;
      setSession(value);
      if (!value || ownerChanged) {
        setState(null);
        setDraft("");
        setSending(false);
        setBusyApproval(null);
        setBusyMemory(null);
        setBusyPause(false);
        setError(null);
        setConnected(false);
        pendingMessage.current = null;
        pendingPromptRuns.current.clear();
        setBusyFeedback(null);
        acceptedRunIds.current.clear();
      }
    },
    [serviceUrl],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reportError = useCallback(
    // Pass the owner token a request used: a late failure from a replaced session must not touch the current one.
    (cause: unknown, ownerToken?: string) => {
      if (ownerToken !== undefined && ownerToken !== activeOwner.current) return;
      if (cause instanceof DotApiError && cause.status === 401) saveSession(null);
      setError(cause instanceof Error ? cause.message : "Could not reach your bot.");
    },
    [saveSession],
  );

  const refresh = useCallback(async () => {
    if (!session || activeOwner.current !== session.ownerToken) return;
    try {
      const result = await client.stateWithRunDetails(session, [...acceptedRunIds.current]);
      if (activeOwner.current !== session.ownerToken) return;
      for (const run of result.runs) {
        if (!isPendingDotRun(run)) acceptedRunIds.current.delete(run.runId);
      }
      setState(result);
      setConnected(true);
    } catch (cause) {
      if (activeOwner.current !== session.ownerToken) return;
      setConnected(false);
      reportError(cause);
    }
  }, [client, reportError, session]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const awaitDotSignIn = window.desktopBridge?.awaitDotSignIn;
    const poll = async () => {
      try {
        let result: DotSession | null;
        if (connection.redirectUri && awaitDotSignIn) {
          const returned = await awaitDotSignIn(connection.redirectUri);
          if (cancelled) return;
          if (returned?.requestId !== connection.requestId)
            throw new Error("Sign-in expired. Please try again.");
          if ("error" in returned)
            throw new Error(
              returned.error === "signups_closed"
                ? SIGNUPS_CLOSED
                : "Sign-in failed. Please try again.",
            );
          result = await client.pollConnection(connection, returned.code);
        } else result = await client.pollConnection(connection);
        if (cancelled) return;
        if (result) {
          saveSession(result);
          setConnection(null);
          setError(null);
        } else timer = setTimeout(() => void poll(), 2000);
      } catch (cause) {
        if (!cancelled) {
          setConnection(null);
          reportError(cause);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (connection.redirectUri)
        void window.desktopBridge?.cancelDotSignIn?.(connection.redirectUri);
    };
  }, [client, connection, reportError, saveSession]);

  const signIn = async () => {
    setConnecting(true);
    setError(null);
    // Owned here until the connection effect takes it over.
    let listener: string | undefined;
    try {
      listener = await window.desktopBridge?.startDotSignIn?.();
      const pending = await client.startConnection(listener);
      if (!mounted.current) return;
      if (pending.redirectUri) listener = undefined;
      setConnection(pending);
      await ensureLocalApi().shell.openExternal(pending.verificationUrl);
    } catch (cause) {
      reportError(cause);
    } finally {
      if (listener) void window.desktopBridge?.cancelDotSignIn?.(listener);
      setConnecting(false);
    }
  };

  const runs = useMemo(
    () =>
      (state?.runs ?? [])
        .filter((run) => run.status !== "cancelled")
        .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [state],
  );

  const feedbackByRun = useMemo(
    () => new Map((state?.feedback ?? []).map((item) => [item.outputId, item])),
    [state],
  );

  useEffect(() => {
    if (runs.length || sending) chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [runs.length, runs.at(-1)?.result?.summary, sending]);

  const send = async () => {
    const sentDraft = draft;
    const text = draft.trim();
    if (!session || !text || sending) return;
    setSending(true);
    setError(null);
    // Retain the command on an ambiguous network failure; retrying must not create another run.
    const message =
      pendingMessage.current?.text === text && pendingMessage.current.threadId === threadId
        ? pendingMessage.current
        : { requestId: randomUUID(), threadId, text };
    pendingMessage.current = message;
    try {
      const accepted = await client.send(session, message);
      if (activeOwner.current !== session.ownerToken) return;
      acceptedRunIds.current.add(accepted.runId);
      pendingMessage.current = null;
      setDraft((current) => draftAfterSend(current, sentDraft));
      await refresh();
    } catch (cause) {
      reportError(cause, session.ownerToken);
    } finally {
      if (activeOwner.current === session.ownerToken) setSending(false);
    }
  };

  const rate = async (
    runId: string,
    rating: DotFeedbackRating,
    reasons: readonly DotFeedbackReason[] = [],
  ) => {
    if (!session) return;
    setBusyFeedback(runId);
    setError(null);
    try {
      await client.rate(session, runId, rating, reasons);
      await refresh();
    } catch (cause) {
      reportError(cause, session.ownerToken);
    } finally {
      if (activeOwner.current === session.ownerToken) setBusyFeedback(null);
    }
  };

  const decide = async (approvalId: string, approved: boolean) => {
    if (!session) return;
    setBusyApproval(approvalId);
    setError(null);
    try {
      await client.decide(session, approvalId, approved);
      await refresh();
    } catch (cause) {
      reportError(cause, session.ownerToken);
    } finally {
      if (activeOwner.current === session.ownerToken) setBusyApproval(null);
    }
  };

  const stopHandling = async (item: DotHandlingItem) => {
    if (!session || activeOwner.current !== session.ownerToken)
      throw new Error("Sign in again to continue.");
    setError(null);
    try {
      const result = await client.stopHandling(session, item);
      if (activeOwner.current !== session.ownerToken)
        throw new Error("Your bot session changed. Sign in again to continue.");
      await refresh();
      return result;
    } catch (cause) {
      if (cause instanceof DotApiError && cause.status === 409) await refresh();
      reportError(cause, session.ownerToken);
      throw cause;
    }
  };

  const markHandlingSeen = async (through: string) => {
    if (!session || activeOwner.current !== session.ownerToken)
      throw new Error("Sign in again to continue.");
    setError(null);
    try {
      const result = await client.markHandlingSeen(session, through);
      if (activeOwner.current !== session.ownerToken)
        throw new Error("Your bot session changed. Sign in again to continue.");
      await refresh();
      return result;
    } catch (cause) {
      reportError(cause, session.ownerToken);
      throw cause;
    }
  };

  const promptAction = async (prompt: DotScheduledPrompt, action: DotScheduledPromptAction) => {
    if (!session || activeOwner.current !== session.ownerToken)
      throw new Error("Sign in again to continue.");
    setError(null);
    let requestId: string | undefined;
    if (action === "run") {
      requestId = pendingPromptRuns.current.get(prompt.promptId) ?? randomUUID();
      pendingPromptRuns.current.set(prompt.promptId, requestId);
    }
    try {
      const result = await client.scheduledPromptAction(
        session,
        prompt.promptId,
        action,
        requestId,
      );
      if (activeOwner.current !== session.ownerToken)
        throw new Error("Your bot session changed. Sign in again to continue.");
      if (action === "run") pendingPromptRuns.current.delete(prompt.promptId);
      if (result.runId) acceptedRunIds.current.add(result.runId);
      await refresh();
      return result;
    } catch (cause) {
      if (cause instanceof DotApiError && activeOwner.current === session.ownerToken) {
        // The bot can report HTTP 400 after reserving a run; acknowledgement is the only safe reset.
        if (cause.status === 409) await refresh();
      }
      reportError(cause, session.ownerToken);
      throw cause;
    }
  };

  const hasPanels =
    state?.handling !== undefined ||
    state?.watches !== undefined ||
    state?.scheduledPrompts !== undefined ||
    state?.capabilities !== undefined ||
    Boolean(state?.capabilitiesError);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <BotIcon className="size-4.5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-foreground">TritonAI Bot</h1>
              <p className="truncate text-xs text-muted-foreground">
                {state?.user.email ?? session?.email ?? "Your campus bot"}
              </p>
            </div>
          </div>
          <Badge variant={connected ? "success" : "warning"} size="sm" className="ms-auto shrink-0">
            {connected
              ? state?.user.paused
                ? "Paused"
                : "Connected"
              : session
                ? "Connecting…"
                : "Sign in"}
          </Badge>
          {session && state?.microsoft?.available !== false && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void ensureLocalApi()
                  .shell.openExternal(`${serviceUrl}/connections`)
                  .catch(reportError);
              }}
            >
              Microsoft calendar
            </Button>
          )}
          {session && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                // Forget the session locally first; server sign-out is best effort (older bots lack it).
                const current = session;
                saveSession(null);
                void client.signOut(current).catch(() => undefined);
              }}
            >
              Disconnect
            </Button>
          )}
        </WorkspacePageHeader>

        <div
          className={cn(
            "mx-auto flex min-h-0 w-full flex-1 flex-col gap-4 px-5 pb-4 sm:px-6",
            hasPanels ? "max-w-6xl" : "max-w-3xl",
          )}
        >
          {!session ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <h2 className="text-lg font-semibold">Connect to your TritonAI Bot</h2>
              <p className="max-w-sm text-sm text-muted-foreground">
                Sign in with your UC San Diego account to get your own personal bot: chat, review
                approvals, and keep your work moving.
              </p>
              {connection ? (
                <>
                  {connection.redirectUri ? null : (
                    <>
                      <p className="text-sm">Confirm this code in the sign-in page:</p>
                      <p className="font-mono text-2xl tracking-widest">{connection.userCode}</p>
                    </>
                  )}
                  <p role="status" className="text-sm text-muted-foreground">
                    {connection.redirectUri
                      ? "Finish signing in with UC San Diego in your browser…"
                      : "Waiting for you to connect…"}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void ensureLocalApi().shell.openExternal(connection.verificationUrl)
                    }
                  >
                    Open sign-in page
                  </Button>
                  <Button variant="ghost" onClick={() => setConnection(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button onClick={() => void signIn()} disabled={connecting}>
                  {connecting ? "Opening sign-in…" : "Sign in with UC San Diego"}
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {state?.microsoft?.available === false
                    ? "Your ongoing conversation"
                    : "Your ongoing conversation · synced with Teams"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!state || !connected || busyPause}
                  onClick={() => {
                    if (!state || busyPause) return;
                    setError(null);
                    setBusyPause(true);
                    void client
                      .pause(session, !state.user.paused, state.user.controlVersion)
                      .then(refresh)
                      .catch(async (cause) => {
                        if (cause instanceof DotApiError && cause.status === 409) await refresh();
                        reportError(cause, session.ownerToken);
                      })
                      .finally(() => setBusyPause(false));
                  }}
                >
                  {state?.user.paused ? "Resume bot" : "Pause bot"}
                </Button>
              </div>
              {state?.microsoft?.available === false && (
                <p role="status" className="text-xs text-muted-foreground">
                  {state.microsoft.message ??
                    "Outlook and calendar aren't available for your account."}
                </p>
              )}
              {state?.user.paused && (
                <p role="status" className="text-sm text-muted-foreground">
                  Your bot is paused. Nothing new starts until you resume it. Reminders, monitors,
                  routines and assignments remain saved. Work already running cannot be recalled.
                </p>
              )}
              <BotMicrosoftBanner
                microsoft={state?.microsoft}
                connectionsUrl={`${serviceUrl}/connections`}
              />
              <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {runs.length === 0 ? (
                      <div className="flex h-full min-h-40 items-center justify-center text-sm text-muted-foreground">
                        {connected ? "Say hello to your bot." : "Connecting to your bot…"}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3 py-2">
                        {runs.map((run) => (
                          <Fragment key={run.runId}>
                            {run.event.kind === "message" && (
                              <div className="flex justify-end">
                                <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground">
                                  {run.event.text}
                                </div>
                              </div>
                            )}
                            <div className="flex justify-start">
                              <div
                                className={cn(
                                  "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
                                  ["failed", "uncertain"].includes(run.status)
                                    ? "bg-destructive/10 text-destructive-foreground"
                                    : "bg-muted text-foreground",
                                )}
                              >
                                {run.result?.summary ??
                                  run.error ??
                                  (isPendingDotRun(run)
                                    ? "Message pending"
                                    : runStatusLabel(run.status))}
                                <BotRunStatus run={run} />
                                {run.result?.summary &&
                                  !isPendingDotRun(run) &&
                                  run.status !== "completed" && (
                                    <p className="mt-2 text-xs text-muted-foreground">
                                      {runStatusLabel(run.status)}
                                    </p>
                                  )}
                              </div>
                            </div>
                            {state?.feedback !== undefined && isRateableRun(run) && (
                              <RunFeedback
                                feedback={feedbackByRun.get(run.runId)}
                                disabled={busyFeedback !== null || !connected}
                                onRate={(rating, reasons) => void rate(run.runId, rating, reasons)}
                              />
                            )}
                          </Fragment>
                        ))}
                        <div ref={chatEndRef} />
                      </div>
                    )}
                  </div>
                  {(state?.approvals.length ?? 0) > 0 && (
                    <section
                      aria-label="Pending approvals"
                      className="max-h-56 shrink-0 overflow-y-auto rounded-xl border p-3"
                    >
                      <h2 className="mb-2 text-sm font-semibold">Needs your approval</h2>
                      {state?.approvals.map((approval) => (
                        <div key={approval.approvalId} className="mb-3 space-y-2 text-sm">
                          <p>{approval.summary}</p>
                          {approval.action === "harness-task" &&
                            state &&
                            taskComputerNotice(state) && (
                              <p className="text-xs text-muted-foreground">
                                {taskComputerNotice(state)}
                              </p>
                            )}
                          <details>
                            <summary className="cursor-pointer text-muted-foreground">
                              Review action details
                            </summary>
                            <dl className="space-y-1 py-2">
                              {Object.entries(approval.payload).map(([key, value]) => (
                                <div key={key}>
                                  <dt className="font-medium">{key}</dt>
                                  <dd className="whitespace-pre-wrap break-words">
                                    {typeof value === "string" ? value : JSON.stringify(value)}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </details>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={busyApproval !== null || state?.user.paused}
                              onClick={() => void decide(approval.approvalId, true)}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyApproval !== null}
                              onClick={() => void decide(approval.approvalId, false)}
                            >
                              Deny
                            </Button>
                          </div>
                        </div>
                      ))}
                    </section>
                  )}
                  {state?.quality && <QualitySummary quality={state.quality} />}
                  <details className="shrink-0 rounded-xl border px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium">
                      Bot memory ·{" "}
                      {(state?.dotMemory ?? []).filter((item) => item.status === "active").length}{" "}
                      active
                    </summary>
                    <div className="mt-2 max-h-52 space-y-3 overflow-y-auto text-sm">
                      <p className="text-xs text-muted-foreground">
                        Ask your bot to remember something, set a reminder, or mark work done.
                        Completed items stop reminders. Forget removes the memory; past chat
                        messages remain.
                      </p>
                      {(state?.dotMemory ?? []).length === 0 && (
                        <p className="text-muted-foreground">Nothing saved yet.</p>
                      )}
                      {(state?.dotMemory ?? []).map((item) => (
                        <div
                          key={item.memoryId}
                          className="flex items-start justify-between gap-3 border-t pt-2"
                        >
                          <div className="min-w-0 whitespace-pre-wrap break-words">
                            <p>{item.text}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {item.status === "completed"
                                ? "Completed"
                                : item.remindAt
                                  ? `Reminder: ${new Date(item.remindAt).toLocaleString()}`
                                  : "Active context"}
                            </p>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            {(item.status === "active"
                              ? (["complete", "forget"] as const)
                              : (["forget"] as const)
                            ).map((action) => (
                              <Button
                                key={action}
                                variant="ghost"
                                size="sm"
                                disabled={busyMemory !== null || !connected}
                                onClick={() => {
                                  if (!session) return;
                                  setBusyMemory(item.memoryId);
                                  void client
                                    .changeMemory(session, item, action)
                                    .then(refresh)
                                    .catch((cause) => reportError(cause, session.ownerToken))
                                    .finally(() => setBusyMemory(null));
                                }}
                              >
                                {action === "complete" ? "Done" : "Forget"}
                              </Button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                  <form
                    className="flex shrink-0 items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void send();
                    }}
                  >
                    <Input
                      nativeInput
                      value={draft}
                      onChange={(event) => setDraft(event.currentTarget.value)}
                      placeholder="Message your bot..."
                      aria-label="Message your bot"
                      className="min-w-0 flex-1"
                    />
                    <Button
                      type="submit"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Send message"
                      disabled={!draft.trim() || sending || !connected}
                    >
                      <SendIcon className="size-4" />
                    </Button>
                  </form>
                </div>
                {hasPanels && (
                  <aside
                    aria-label="Bot activity and capabilities"
                    className="flex max-h-[40%] min-h-0 shrink-0 flex-col gap-3 overflow-y-auto lg:max-h-none lg:w-80"
                  >
                    {!connected && (
                      <p role="status" className="text-xs text-muted-foreground">
                        Connection interrupted. These are the last received updates.
                      </p>
                    )}
                    <BotHandlingPanel
                      handling={state?.handling}
                      onStop={stopHandling}
                      onSeen={markHandlingSeen}
                    />
                    <BotRoutinesPanel
                      watches={state?.watches}
                      scheduledPrompts={state?.scheduledPrompts}
                      onPromptAction={promptAction}
                    />
                    <BotCapabilitiesPanel
                      capabilities={state?.capabilities}
                      capabilitiesError={state?.capabilitiesError}
                    />
                  </aside>
                )}
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="shrink-0 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

/** Ratings record the owner's judgment only; they never change what the bot sends. */
function RunFeedback({
  feedback,
  disabled,
  onRate,
}: {
  readonly feedback: DotFeedback | undefined;
  readonly disabled: boolean;
  readonly onRate: (rating: DotFeedbackRating, reasons: readonly DotFeedbackReason[]) => void;
}) {
  const reasons = feedback?.rating === "not-useful" ? (feedback.reasons ?? []) : [];
  return (
    <div className="-mt-1 flex flex-wrap items-center gap-1 ps-2 text-xs text-muted-foreground">
      <Button
        variant={feedback?.rating === "useful" ? "secondary" : "ghost"}
        size="compact"
        aria-pressed={feedback?.rating === "useful"}
        disabled={disabled}
        onClick={() => onRate("useful", [])}
      >
        👍 Useful
      </Button>
      <Button
        variant={feedback?.rating === "not-useful" ? "secondary" : "ghost"}
        size="compact"
        aria-pressed={feedback?.rating === "not-useful"}
        disabled={disabled}
        onClick={() => onRate("not-useful", reasons)}
      >
        👎 Not useful
      </Button>
      {feedback?.rating === "not-useful" &&
        DOT_FEEDBACK_REASONS.map((reason) => {
          const selected = reasons.includes(reason.id);
          return (
            <Button
              key={reason.id}
              variant={selected ? "secondary" : "ghost"}
              size="compact"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() =>
                onRate(
                  "not-useful",
                  selected ? reasons.filter((item) => item !== reason.id) : [...reasons, reason.id],
                )
              }
            >
              {reason.label}
            </Button>
          );
        })}
    </div>
  );
}

function QualitySummary({ quality }: { readonly quality: DotQuality }) {
  const week = quality.windows.find((window) => window.days === 7);
  if (!week || (!week.total.delivered && !week.total.rated)) return null;
  const { delivered, rated, useful } = week.total;
  return (
    <p role="status" className="shrink-0 text-xs text-muted-foreground">
      Last 7 days: {delivered} proactive {delivered === 1 ? "message" : "messages"} delivered ·{" "}
      {rated
        ? `${useful} of ${rated} rated useful (${Math.round((useful / rated) * 100)}%)`
        : "no ratings yet"}
    </p>
  );
}
