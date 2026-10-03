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
import {
  DotApiError,
  DotClient,
  readDotSession,
  runStatusLabel,
  saveDotSession,
  type DotSession,
  type DotState,
  type PendingConnection,
  type PendingMessage,
} from "./dotClient";

const DOT_API_URL = (
  import.meta.env.VITE_DOT_BRIDGE_URL?.trim() || ""
).replace(/\/$/, "");
const client = new DotClient(DOT_API_URL);
export function DotPage() {
  const [session, setSession] = useState<DotSession | null>(() =>
    readDotSession(sessionStorage, DOT_API_URL),
  );
  const [state, setState] = useState<DotState | null>(null);
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState<PendingConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const threadId = state?.streamId ?? "dot";
  const [busyMemory, setBusyMemory] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const pendingMessage = useRef<PendingMessage | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const activeOwner = useRef(session?.ownerToken);

  const saveSession = useCallback((value: DotSession | null) => {
    saveDotSession(sessionStorage, DOT_API_URL, value);
    activeOwner.current = value?.ownerToken;
    setSession(value);
    if (!value) {
      setState(null);
      setConnected(false);
      pendingMessage.current = null;
    }
  }, []);

  const reportError = useCallback(
    (cause: unknown) => {
      if (cause instanceof DotApiError && cause.status === 401) saveSession(null);
      setError(cause instanceof Error ? cause.message : "Could not reach your bot.");
    },
    [saveSession],
  );

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      const result = await client.state(session);
      if (activeOwner.current !== session.ownerToken) return;
      setState(result);
      setConnected(true);
    } catch (cause) {
      if (activeOwner.current !== session.ownerToken) return;
      setConnected(false);
      reportError(cause);
    }
  }, [reportError, session]);

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
    const poll = async () => {
      try {
        const result = await client.pollConnection(connection);
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
    };
  }, [connection, reportError, saveSession]);

  const signIn = async () => {
    setConnecting(true);
    setError(null);
    try {
      const pending = await client.startConnection();
      setConnection(pending);
      await ensureLocalApi().shell.openExternal(pending.verificationUrl);
    } catch (cause) {
      reportError(cause);
    } finally {
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

  useEffect(() => {
    if (runs.length || sending) chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [runs.length, runs.at(-1)?.result?.summary, sending]);

  const send = async () => {
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
      await client.send(session, message);
      pendingMessage.current = null;
      setDraft("");
      await refresh();
    } catch (cause) {
      reportError(cause);
    } finally {
      setSending(false);
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
      reportError(cause);
    } finally {
      setBusyApproval(null);
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <BotIcon className="size-4.5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-foreground">Your dot</h1>
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
          {session && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void ensureLocalApi()
                  .shell.openExternal(`${DOT_API_URL}/connections`)
                  .catch(reportError);
              }}
            >
              Microsoft calendar
            </Button>
          )}
          {session && (
            <Button variant="ghost" size="sm" onClick={() => saveSession(null)}>
              Disconnect
            </Button>
          )}
        </WorkspacePageHeader>

        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4 px-5 pb-4 sm:px-6">
          {!session ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <h2 className="text-lg font-semibold">Connect to your bot</h2>
              <p className="max-w-sm text-sm text-muted-foreground">
                Sign in with UC San Diego to chat, review approvals, and keep your work moving.
              </p>
              {connection ? (
                <>
                  <p className="text-sm">Confirm this code in the sign-in page:</p>
                  <p className="font-mono text-2xl tracking-widest">{connection.userCode}</p>
                  <p role="status" className="text-sm text-muted-foreground">
                    Waiting for you to connect…
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
                  Your ongoing conversation · synced with Teams
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!state}
                  onClick={() => {
                    if (session && state)
                      void client
                        .pause(session, !state.user.paused)
                        .then(refresh)
                        .catch(reportError);
                  }}
                >
                  {state?.user.paused ? "Resume bot" : "Pause bot"}
                </Button>
              </div>
              {state?.user.paused && (
                <p role="status" className="text-sm text-muted-foreground">
                  Your bot is paused. Queued messages will continue when you resume it.
                </p>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {runs.length === 0 ? (
                  <div className="flex h-full min-h-40 items-center justify-center text-sm text-muted-foreground">
                    {connected ? "Say hello to your dot." : "Connecting to your dot…"}
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
                            {run.result?.summary ?? run.error ?? runStatusLabel(run.status)}
                            {run.result?.summary && run.status !== "completed" && (
                              <p className="mt-2 text-xs text-muted-foreground">
                                {runStatusLabel(run.status)}
                              </p>
                            )}
                          </div>
                        </div>
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
              <details className="shrink-0 rounded-xl border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">
                  Dot memory ·{" "}
                  {(state?.dotMemory ?? []).filter((item) => item.status === "active").length}{" "}
                  active
                </summary>
                <div className="mt-2 max-h-52 space-y-3 overflow-y-auto text-sm">
                  <p className="text-xs text-muted-foreground">
                    Ask your dot to remember something, set a reminder, or mark work done. Completed
                    items stop reminders. Forget removes the memory; past chat messages remain.
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
                                .catch(reportError)
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
                className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 focus-within:border-ring"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <Input
                  nativeInput
                  unstyled
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  placeholder="Message your dot..."
                  aria-label="Message your dot"
                  className="min-w-0 flex-1 border-0 bg-transparent px-1 text-sm leading-6 text-foreground placeholder:text-placeholder focus-visible:ring-0"
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
