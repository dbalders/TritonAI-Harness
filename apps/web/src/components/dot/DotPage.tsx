import { BotIcon, SendIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const DOT_BRIDGE_URL = import.meta.env.VITE_DOT_BRIDGE_URL?.trim() || "http://127.0.0.1:8787";
const DOT_USER_ID = import.meta.env.VITE_DOT_USER_ID?.trim() ?? "";
const DOT_POLL_MS = 5000;

interface DotUser {
  readonly userId: string;
  readonly email?: string;
}

interface DotTask {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: string;
  readonly detail?: {
    readonly channel?: string;
    readonly text?: string;
  };
}

interface DotStateResponse {
  readonly ok: boolean;
  readonly user?: DotUser;
  readonly tasks?: readonly DotTask[];
}

interface DotMessage {
  readonly taskId: string;
  readonly text: string;
  readonly reply: string;
  readonly failed: boolean;
  readonly createdAt: string;
}

function dotFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${DOT_BRIDGE_URL}${path}`, init);
}

async function loadDotState(): Promise<DotStateResponse> {
  if (!DOT_USER_ID) throw new Error("Dot user is not configured.");
  const response = await dotFetch(`/state?userId=${encodeURIComponent(DOT_USER_ID)}`);
  if (!response.ok) throw new Error(`Dot state request failed (${response.status}).`);
  return (await response.json()) as DotStateResponse;
}

function toMessage(task: DotTask): DotMessage | null {
  if (task.detail?.channel !== "harness" || typeof task.detail.text !== "string") return null;
  return {
    taskId: task.taskId,
    text: task.detail.text,
    reply: task.result ?? "",
    failed: task.status === "failed",
    createdAt: task.createdAt,
  };
}

export function DotPage() {
  const [connected, setConnected] = useState(false);
  const [user, setUser] = useState<DotUser | null>(null);
  const [tasks, setTasks] = useState<readonly DotTask[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await loadDotState();
      setConnected(true);
      setUser(state.user ?? null);
      setTasks(state.tasks ?? []);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, DOT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const messages = useMemo(
    () =>
      tasks
        .map(toMessage)
        .filter((message): message is DotMessage => message !== null)
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [tasks],
  );

  const activity = useMemo(
    () => tasks.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [tasks],
  );

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, sending]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (!DOT_USER_ID) {
      setSendError("Dot user is not configured.");
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const response = await dotFetch("/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: DOT_USER_ID, text }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || body.ok !== true) {
        throw new Error(body.error ?? `Dot request failed (${response.status}).`);
      }
      setDraft("");
      await refresh();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not reach your dot.");
    } finally {
      setSending(false);
    }
  }, [draft, refresh, sending]);

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
              <p className="truncate text-xs text-muted-foreground">{user?.email ?? DOT_USER_ID}</p>
            </div>
          </div>
          <Badge variant={connected ? "success" : "warning"} size="sm" className="ms-auto shrink-0">
            <span
              className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-warning")}
            />
            {connected ? "Connected" : "Offline"}
          </Badge>
        </WorkspacePageHeader>

        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4 px-5 pb-4 sm:px-6">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {messages.length === 0 ? (
              <div className="flex h-full min-h-40 items-center justify-center text-sm text-muted-foreground">
                {connected ? "Say hello to your dot." : "Waiting for the dot bridge…"}
              </div>
            ) : (
              <div className="flex flex-col gap-3 py-2">
                {messages.map((message) => (
                  <Fragment key={message.taskId}>
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground">
                        {message.text}
                      </div>
                    </div>
                    {message.reply ? (
                      <div className="flex justify-start">
                        <div
                          className={cn(
                            "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
                            message.failed
                              ? "bg-destructive/10 text-destructive-foreground"
                              : "bg-muted text-foreground",
                          )}
                        >
                          {message.reply}
                        </div>
                      </div>
                    ) : null}
                  </Fragment>
                ))}
                {sending ? (
                  <div className="flex justify-start">
                    <div className="rounded-2xl bg-muted px-4 py-2.5 text-sm text-muted-foreground">
                      Working…
                    </div>
                  </div>
                ) : null}
                <div ref={chatEndRef} />
              </div>
            )}
          </div>

          <section aria-label="Dot activity" className="shrink-0">
            <h2 className="px-1 pb-1 text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
              Activity
            </h2>
            {activity.length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">No activity yet.</p>
            ) : (
              <ul className="flex flex-col">
                {activity.slice(0, 8).map((task) => (
                  <li
                    key={task.taskId}
                    className="flex items-center gap-2.5 rounded-md px-1 py-2 text-sm"
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        task.status === "completed"
                          ? "bg-success"
                          : task.status === "failed"
                            ? "bg-destructive"
                            : "bg-muted-foreground/50",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground">{task.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{task.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

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
              disabled={!draft.trim() || sending}
            >
              <SendIcon className="size-4" />
            </Button>
          </form>
          {sendError ? (
            <p role="alert" className="shrink-0 text-xs text-destructive">
              {sendError}
            </p>
          ) : null}
        </div>
      </div>
    </SidebarInset>
  );
}
