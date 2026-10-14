import { Link, useNavigate } from "@tanstack/react-router";
import { BotIcon, SendIcon, PaperclipIcon } from "lucide-react";
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
import { BotResultCard } from "./BotResultCard";
import { BotMemoryPanel, BotMemoryEditor } from "./BotMemoryPanel";
import { BotResponsibilitiesPanel } from "./BotResponsibilitiesPanel";
import type { DotRoutineInput } from "./BotRoutineEditor";
import {
  botWebUrl,
  type DotAttachment,
  type DotMemoryInput,
  type DotResponsibilityInput,
  replyRoutingText,
} from "./dotEnhancements";
import { BotRunStatus } from "./BotRunStatus";
import { BotWaitingStatus } from "./BotWaitingStatus";
import { usableWaiting, type DotWaitingAction } from "./dotWaiting";
import { BotHandlingPanel } from "./BotHandlingPanel";
import { BotRoutinesPanel } from "./BotRoutinesPanel";
import { BotFileRecipesPanel } from "./BotFileRecipesPanel";
import type { DotFileRecipeInput } from "./dotFileRecipes";
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
  type DotTask,
  type DotApproval,
  type DotRun,
  type PendingConnection,
  type PendingMessage,
} from "./dotClient";

const SIGNUPS_CLOSED = "TritonAI Bot isn't accepting new users right now.";

/**
 * Keeps the newer of two copies of each versioned record. Reads are ordered by request, but an older copy must never
 * replace a newer one this workspace has already shown for the same owner.
 */
function keepNewest<T>(
  previous: readonly T[] | undefined,
  next: readonly T[] | undefined,
  id: (item: T) => string,
  version: (item: T) => number | undefined,
): readonly T[] | undefined {
  if (!previous || !next) return next;
  const shown = new Map(previous.map((item) => [id(item), item]));
  return next.map((item) => {
    const before = shown.get(id(item));
    const older = before === undefined ? undefined : version(before);
    const current = version(item);
    return before !== undefined && older !== undefined && current !== undefined && older > current
      ? before
      : item;
  });
}

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
  const navigate = useNavigate();
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
  const [attachments, setAttachments] = useState<readonly DotAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const uploadingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [preferenceRun, setPreferenceRun] = useState<string | null>(null);
  const pendingRoutine = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const pendingFileRecipe = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyApproval, setBusyApproval] = useState<string | null>(null);
  const [busyFeedback, setBusyFeedback] = useState<string | null>(null);
  const pendingMessage = useRef<PendingMessage | null>(null);
  // The responsibility the next message explicitly replies to, chosen from Responsibilities.
  const [replyTarget, setReplyTarget] = useState<{ id: string; title: string } | null>(null);
  const [replyStatus, setReplyStatus] = useState<string | null>(null);
  const composerInput = useRef<HTMLInputElement>(null);
  const acceptedRunIds = useRef(new Set<string>());
  const stateRequestSequence = useRef(0);
  const latestSnapshot = useRef<DotState | null>(null);
  // Older followed tasks may fall outside /state's recent-task window. Load them only on demand.
  const taskEvidence = useRef(new Map<string, DotTask>());
  const approvalEvidence = useRef(new Map<string, DotApproval>());
  // Finished conversation runs outside the newest page, loaded on demand to show how a reply's continuation ended.
  const runEvidence = useRef(new Map<string, DotRun>());
  const openingItems = useRef(new Set<string>());
  const pendingOpen = useRef<{
    kind: string;
    id: string;
    ownerToken: string;
  } | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const activeOwner = useRef(session?.ownerToken);
  const mounted = useRef(true);

  const saveSession = useCallback(
    (value: DotSession | null) => {
      if (!mounted.current) return;
      const storedSession = readDotSession(sessionStorage, serviceUrl);
      // Another workspace may have replaced the persisted session while this one was waiting.
      if (value || !storedSession || storedSession.ownerToken === activeOwner.current)
        saveDotSession(sessionStorage, serviceUrl, value);
      const ownerChanged = activeOwner.current !== value?.ownerToken;
      activeOwner.current = value?.ownerToken;
      setSession(value);
      if (!value || ownerChanged) {
        setState(null);
        setDraft("");
        setSending(false);
        setBusyApproval(null);
        setAttachments([]);
        setUploading(false);
        setUploadStatus(null);
        setPreferenceRun(null);
        pendingRoutine.current = null;
        setBusyPause(false);
        setError(null);
        setConnected(false);
        pendingMessage.current = null;
        setReplyTarget(null);
        setReplyStatus(null);
        pendingPromptRuns.current.clear();
        setBusyFeedback(null);
        acceptedRunIds.current.clear();
        taskEvidence.current.clear();
        approvalEvidence.current.clear();
        runEvidence.current.clear();
        openingItems.current.clear();
        pendingOpen.current = null;
        latestSnapshot.current = null;
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
      if (!mounted.current) return;
      if (ownerToken !== undefined && ownerToken !== activeOwner.current) return;
      if (cause instanceof DotApiError && cause.status === 401) saveSession(null);
      setError(cause instanceof Error ? cause.message : "Could not reach your bot.");
    },
    [saveSession],
  );

  const refresh = useCallback(async () => {
    if (!session || activeOwner.current !== session.ownerToken || !mounted.current) return;
    const requestSequence = ++stateRequestSequence.current;
    try {
      const result = await client.stateWithRunDetails(session, [...acceptedRunIds.current]);
      if (
        !mounted.current ||
        activeOwner.current !== session.ownerToken ||
        requestSequence !== stateRequestSequence.current
      )
        return;
      const merged: DotState = {
        ...result,
        ...(result.responsibilities
          ? {
              responsibilities: keepNewest(
                latestSnapshot.current?.responsibilities,
                result.responsibilities,
                (item) => item.responsibilityId,
                (item) => item.version,
              )!,
            }
          : {}),
        ...(result.fileRecipes
          ? {
              fileRecipes: keepNewest(
                latestSnapshot.current?.fileRecipes,
                result.fileRecipes,
                (item) => item.recipeId,
                (item) => item.version,
              )!,
            }
          : {}),
      };
      latestSnapshot.current = merged;
      for (const run of merged.runs) {
        if (!isPendingDotRun(run)) acceptedRunIds.current.delete(run.runId);
      }
      const followed = new Map(
        (merged.responsibilities ?? []).map((item) => [item.source.taskId, item.sourceEvidence]),
      );
      // A finished assignment a file recipe links to stays loaded; finished results don't change.
      const recipeTasks = new Set(
        (merged.fileRecipes ?? []).flatMap((recipe) =>
          recipe.events.flatMap((event) => (event.taskId ? [event.taskId] : [])),
        ),
      );
      for (const [taskId, cached] of taskEvidence.current) {
        const evidence = followed.get(taskId);
        const recent = merged.tasks.find((task) => task.taskId === taskId);
        const inbox = merged.handling?.items.find(
          (item) => item.target?.kind === "task" && item.target.id === taskId,
        );
        const recipeResult =
          recipeTasks.has(taskId) && ["completed", "failed", "cancelled"].includes(cached.status);
        if (
          (!followed.has(taskId) && !inbox && !recipeResult) ||
          (evidence && evidence.updatedAt !== (recent ?? cached).updatedAt) ||
          (inbox && inbox.version !== (recent ?? cached).updatedAt)
        )
          taskEvidence.current.delete(taskId);
        else if (recent) taskEvidence.current.set(taskId, recent);
      }
      const tasks = new Map([
        ...taskEvidence.current,
        ...merged.tasks.map((task) => [task.taskId, task] as const),
      ]);
      for (const [approvalId] of approvalEvidence.current) {
        const recent = merged.approvals.find((approval) => approval.approvalId === approvalId);
        if (
          !merged.handling?.items.some(
            (item) => item.target?.kind === "approval" && item.target.id === approvalId,
          )
        )
          approvalEvidence.current.delete(approvalId);
        else if (recent) approvalEvidence.current.set(approvalId, recent);
      }
      const approvals = new Map([
        ...approvalEvidence.current,
        ...merged.approvals.map((approval) => [approval.approvalId, approval] as const),
      ]);
      // A loaded older run stays in the conversation until the newest page includes it; finished runs don't change.
      for (const [runId] of runEvidence.current)
        if (merged.runs.some((run) => run.runId === runId)) runEvidence.current.delete(runId);
      setState({
        ...merged,
        tasks: [...tasks.values()],
        approvals: [...approvals.values()],
        runs: [...merged.runs, ...runEvidence.current.values()],
      });
      setConnected(true);
    } catch (cause) {
      if (
        !mounted.current ||
        activeOwner.current !== session.ownerToken ||
        requestSequence !== stateRequestSequence.current
      )
        return;
      setConnected(false);
      reportError(cause, session.ownerToken);
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
    const sentAttachments = attachments;
    const text = draft.trim() || (attachments.length ? "Please review the attached files." : "");
    if (!session || !text || sending || uploading) return;
    const attachmentIds = attachments.map((item) => item.attachmentId);
    const responsibilityId =
      state?.enhancements?.replyContinuation && replyTarget ? replyTarget.id : undefined;
    setSending(true);
    setError(null);
    setReplyStatus(null);
    // Retain the command on an ambiguous network failure; retrying must not create another run.
    const message =
      pendingMessage.current?.text === text &&
      pendingMessage.current.threadId === threadId &&
      pendingMessage.current.responsibilityId === responsibilityId &&
      JSON.stringify(pendingMessage.current.attachmentIds ?? []) === JSON.stringify(attachmentIds)
        ? pendingMessage.current
        : {
            requestId: randomUUID(),
            threadId,
            text,
            ...(attachmentIds.length ? { attachmentIds } : {}),
            ...(responsibilityId ? { responsibilityId } : {}),
          };
    pendingMessage.current = message;
    try {
      const accepted = await client.send(session, message);
      if (activeOwner.current !== session.ownerToken) return;
      acceptedRunIds.current.add(accepted.runId);
      pendingMessage.current = null;
      if (responsibilityId) setReplyTarget(null);
      setReplyStatus(replyRoutingText(accepted.reply));
      setDraft((current) => draftAfterSend(current, sentDraft));
      setAttachments((current) =>
        current.filter(
          (item) => !sentAttachments.some((sent) => sent.attachmentId === item.attachmentId),
        ),
      );
      setUploadStatus(null);
      await refresh();
    } catch (cause) {
      // A rejected reply queued nothing: keep the draft and target, and say why beside the composer.
      if (
        responsibilityId &&
        cause instanceof DotApiError &&
        (cause.status === 404 || cause.status === 409) &&
        activeOwner.current === session.ownerToken
      ) {
        pendingMessage.current = null;
        setReplyStatus(`Not sent: ${cause.message}`);
        await refresh();
      } else reportError(cause, session.ownerToken);
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

  async function mutate<T>(operation: (owner: DotSession) => Promise<T>): Promise<T> {
    if (!session || activeOwner.current !== session.ownerToken)
      throw new Error("Sign in again to continue.");
    setError(null);
    try {
      const result = await operation(session);
      if (activeOwner.current !== session.ownerToken)
        throw new Error("Your bot session changed. Sign in again to continue.");
      await refresh();
      return result;
    } catch (cause) {
      if (cause instanceof DotApiError && cause.status === 409) await refresh();
      reportError(cause, session.ownerToken);
      throw cause;
    }
  }

  const saveRoutine = async (input: DotRoutineInput, prompt?: DotScheduledPrompt) => {
    const fingerprint = JSON.stringify(input);
    if (!pendingRoutine.current || pendingRoutine.current.fingerprint !== fingerprint)
      pendingRoutine.current = { fingerprint, requestId: randomUUID() };
    const result = await mutate((owner) =>
      client.saveRoutine(owner, input, pendingRoutine.current!.requestId, prompt),
    );
    pendingRoutine.current = null;
    return result;
  };
  // A retried create with the same input reuses its request ID, so the bot returns the same recipe.
  const createFileRecipe = async (input: DotFileRecipeInput & { readonly folderId: string }) => {
    const fingerprint = JSON.stringify(input);
    if (!pendingFileRecipe.current || pendingFileRecipe.current.fingerprint !== fingerprint)
      pendingFileRecipe.current = { fingerprint, requestId: randomUUID() };
    const result = await mutate((owner) =>
      client.createFileRecipe(owner, input, pendingFileRecipe.current!.requestId),
    );
    pendingFileRecipe.current = null;
    return result;
  };
  const responsibilityAction = (input: DotResponsibilityInput) =>
    mutate((owner) => client.responsibility(owner, input));
  const memoryEdit = (input: DotMemoryInput) => mutate((owner) => client.editMemory(owner, input));

  const openItem = useCallback((kind: string, id: string) => {
    const element = document.getElementById(`bot-${kind}-${id}`);
    if (!element) return;
    if (element instanceof HTMLDetailsElement) element.open = true;
    let parent = element.parentElement;
    while (parent) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
      parent = parent.parentElement;
    }
    element.scrollIntoView({ block: "nearest" });
    element.focus();
  }, []);
  useEffect(() => {
    const target = pendingOpen.current;
    if (!target || activeOwner.current !== target.ownerToken) return;
    if (!document.getElementById(`bot-${target.kind}-${target.id}`)) return;
    openItem(target.kind, target.id);
    pendingOpen.current = null;
  }, [state, openItem]);

  function cacheEvidence<T>(cache: Map<string, T>, id: string, value: T) {
    cache.delete(id);
    cache.set(id, value);
    while (cache.size > 20) cache.delete(cache.keys().next().value!);
  }
  function handlingTarget(item: DotHandlingItem) {
    if (item.target) return item.target;
    if (item.kind === "approval" && state?.approvals.some((value) => value.approvalId === item.id))
      return { kind: "approval", id: item.id };
    if (item.kind === "run" && state?.runs.some((value) => value.runId === item.id))
      return { kind: "run", id: item.id };
    if (
      item.kind === "harness-assignment" &&
      state?.tasks.some((value) => value.taskId === item.id)
    )
      return { kind: "task", id: item.id };
    return undefined;
  }
  async function handlingOpen(item: DotHandlingItem) {
    const target = handlingTarget(item);
    if (target && document.getElementById(`bot-${target.kind}-${target.id}`)) {
      openItem(target.kind, target.id);
      return;
    }
    if (
      target &&
      state?.enhancements?.decisionInbox &&
      session &&
      (target.kind === "task" || target.kind === "approval")
    ) {
      const ownerToken = session.ownerToken;
      const key = `${ownerToken}:${target.kind}:${target.id}`;
      if (activeOwner.current !== ownerToken || openingItems.current.has(key)) return;
      openingItems.current.add(key);
      setError(null);
      try {
        if (target.kind === "task") {
          await loadTaskEvidence(target.id, true);
        } else {
          const { approval } = await client.approval(session, target.id);
          if (activeOwner.current !== ownerToken || !mounted.current) return;
          if (approval.approvalId !== target.id || approval.status !== "pending")
            throw new Error(
              "This approval is no longer pending. Refresh the inbox before continuing.",
            );
          if (
            !latestSnapshot.current?.handling?.items.some(
              (value) => value.target?.kind === "approval" && value.target.id === target.id,
            )
          )
            throw new Error("This approval changed. Refresh the inbox before continuing.");
          stateRequestSequence.current += 1;
          cacheEvidence(approvalEvidence.current, target.id, approval);
          pendingOpen.current = { ...target, ownerToken };
          setState((current) =>
            current
              ? {
                  ...current,
                  approvals: [
                    ...current.approvals.filter((value) => value.approvalId !== target.id),
                    approval,
                  ],
                }
              : current,
          );
        }
      } catch (cause) {
        reportError(cause, ownerToken);
      } finally {
        openingItems.current.delete(key);
      }
    } else {
      const link = botWebUrl(item.source?.link);
      if (link) void ensureLocalApi().shell.openExternal(link).catch(reportError);
    }
  }
  const handlingResponsibility = (item: DotHandlingItem, action: "snooze" | "resume") => {
    const responsibility = state?.responsibilities?.find(
      (value) => value.responsibilityId === (item.target?.id ?? item.id),
    );
    if (!responsibility) return Promise.reject(new Error("Refresh the inbox before trying again."));
    // Use the version of the item the owner actually saw, never substitute a refreshed version.
    const expectedVersion = responsibility.version;
    if (
      item.version !== `responsibility:${expectedVersion}` &&
      item.version !== String(expectedVersion)
    )
      return Promise.reject(new Error("This item changed. Refresh the inbox before trying again."));
    return responsibilityAction(
      action === "snooze"
        ? {
            action,
            responsibilityId: responsibility.responsibilityId,
            expectedVersion,
            until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }
        : { action, responsibilityId: responsibility.responsibilityId, expectedVersion },
    );
  };

  async function attachFiles(files: FileList | null) {
    if (!session || !files || uploadingRef.current) return;
    if (files.length + attachments.length > 3) {
      setUploadStatus("Attach up to three files per message.");
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    setUploadStatus(null);
    try {
      for (const file of Array.from(files)) {
        setUploadStatus(`Uploading ${file.name}…`);
        const attachment = await client.uploadAttachment(session, file);
        if (activeOwner.current !== session.ownerToken) return;
        setAttachments((current) =>
          current.some((item) => item.attachmentId === attachment.attachmentId)
            ? current
            : [...current, attachment],
        );
      }
      setUploadStatus(
        "Files ready to send. They are shared with your bot when you send this message.",
      );
    } catch (cause) {
      if (activeOwner.current === session.ownerToken)
        setUploadStatus(
          cause instanceof Error ? cause.message : "Upload failed. Choose the file again to retry.",
        );
      if (cause instanceof DotApiError && cause.status === 401)
        reportError(cause, session.ownerToken);
    } finally {
      uploadingRef.current = false;
      if (activeOwner.current === session.ownerToken) setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function loadTaskEvidence(taskId: string, openAfterLoad = false) {
    if (!session || activeOwner.current !== session.ownerToken)
      throw new Error("Sign in again to continue.");
    try {
      const { task } = await client.task(session, taskId);
      if (activeOwner.current !== session.ownerToken || !mounted.current)
        throw new Error("Your bot session changed. Sign in again to continue.");
      if (task.taskId !== taskId || task.detail?.kind !== "harness-task")
        throw new Error("The selected task evidence is unavailable.");
      const knownTimes = [
        taskEvidence.current.get(taskId)?.updatedAt,
        latestSnapshot.current?.tasks.find((value) => value.taskId === taskId)?.updatedAt,
        latestSnapshot.current?.handling?.items.find(
          (value) => value.target?.kind === "task" && value.target.id === taskId,
        )?.version,
        ...(latestSnapshot.current?.responsibilities ?? [])
          .filter((value) => value.source.taskId === taskId)
          .map((value) => value.sourceEvidence?.updatedAt),
      ];
      if (knownTimes.some((value) => value && Date.parse(value) > Date.parse(task.updatedAt)))
        throw new Error("The selected task evidence changed. Load it again before reviewing.");
      stateRequestSequence.current += 1;
      cacheEvidence(taskEvidence.current, taskId, task);
      if (openAfterLoad)
        pendingOpen.current = { kind: "task", id: taskId, ownerToken: session.ownerToken };
      setState((current) =>
        current
          ? { ...current, tasks: [...current.tasks.filter((item) => item.taskId !== taskId), task] }
          : current,
      );
    } catch (cause) {
      reportError(cause, session.ownerToken);
      throw cause;
    }
  }

  /** Pauses or resumes against the displayed control version; a newer change since then is refused, not overwritten. */
  function togglePause(paused: boolean) {
    if (!session || !state || busyPause || state.user.paused === paused) return;
    setError(null);
    setBusyPause(true);
    void client
      .pause(session, paused, state.user.controlVersion)
      .then(refresh)
      .catch(async (cause) => {
        if (cause instanceof DotApiError && cause.status === 409) await refresh();
        reportError(cause, session.ownerToken);
      })
      .finally(() => setBusyPause(false));
  }

  /**
   * Opens a conversation run outside the newest page through the owner-scoped run route, so an outcome the snapshot
   * couldn't confirm is read from the run's own record where it was answered.
   */
  async function openRun(runId: string) {
    if (document.getElementById(`bot-run-${runId}`)) {
      openItem("run", runId);
      return;
    }
    if (!session) return;
    const ownerToken = session.ownerToken;
    const key = `${ownerToken}:run:${runId}`;
    if (activeOwner.current !== ownerToken || openingItems.current.has(key)) return;
    openingItems.current.add(key);
    setError(null);
    try {
      const { run } = await client.run(session, runId);
      if (activeOwner.current !== ownerToken || !mounted.current) return;
      if (run.runId !== runId) throw new Error("That conversation message is unavailable.");
      stateRequestSequence.current += 1;
      if (!isPendingDotRun(run)) cacheEvidence(runEvidence.current, runId, run);
      pendingOpen.current = { kind: "run", id: runId, ownerToken };
      setState((current) =>
        current
          ? { ...current, runs: [...current.runs.filter((value) => value.runId !== runId), run] }
          : current,
      );
    } catch (cause) {
      reportError(cause, ownerToken);
    } finally {
      openingItems.current.delete(key);
    }
  }

  /**
   * Opens a decision outside the current page of pending approvals through the owner-scoped approval route. Only a
   * still-pending decision is shown for action; anything else is reported, never displayed as pending.
   */
  async function openApproval(approvalId: string) {
    if (document.getElementById(`bot-approval-${approvalId}`)) {
      openItem("approval", approvalId);
      return;
    }
    if (!session) return;
    const ownerToken = session.ownerToken;
    const key = `${ownerToken}:approval:${approvalId}`;
    if (activeOwner.current !== ownerToken || openingItems.current.has(key)) return;
    openingItems.current.add(key);
    setError(null);
    try {
      const { approval } = await client.approval(session, approvalId);
      if (activeOwner.current !== ownerToken || !mounted.current) return;
      if (approval.approvalId !== approvalId || approval.status !== "pending")
        throw new Error("This decision is no longer pending. Refresh to see its outcome.");
      stateRequestSequence.current += 1;
      cacheEvidence(approvalEvidence.current, approvalId, approval);
      pendingOpen.current = { kind: "approval", id: approvalId, ownerToken };
      setState((current) =>
        current
          ? {
              ...current,
              approvals: [
                ...current.approvals.filter((value) => value.approvalId !== approvalId),
                approval,
              ],
            }
          : current,
      );
    } catch (cause) {
      reportError(cause, ownerToken);
    } finally {
      openingItems.current.delete(key);
    }
  }

  /** Recovery from a waiting status: each action goes to the existing control for it. */
  function waitingAction(action: DotWaitingAction) {
    const target = action.target;
    if (action.kind === "resume-bot") return togglePause(false);
    if (action.kind === "reconnect")
      return void ensureLocalApi()
        .shell.openExternal(`${serviceUrl}/connections`)
        .catch(reportError);
    if (action.kind === "task-computer") return void navigate({ to: "/settings/tritonai-bot" });
    if (action.kind === "reply") {
      const item = state?.responsibilities?.find((value) => value.responsibilityId === target?.id);
      if (!item || !state?.enhancements?.replyContinuation) return;
      setReplyTarget({ id: item.responsibilityId, title: item.title });
      setReplyStatus(null);
      composerInput.current?.focus();
      return;
    }
    if (!target) return;
    if (target.kind === "approval") return void openApproval(target.id);
    if (target.kind === "run") return void openRun(target.id);
    if (target.kind === "task") {
      if (document.getElementById(`bot-task-${target.id}`)) return openItem("task", target.id);
      return void loadTaskEvidence(target.id, true).catch(() => undefined);
    }
    openItem(target.kind === "recipe" ? "file-recipe" : target.kind, target.id);
  }

  async function downloadAttachment(attachmentId: string) {
    if (!session) throw new Error("Sign in again to continue.");
    const result = await client.downloadAttachment(session, attachmentId);
    if (activeOwner.current !== session.ownerToken) return;
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const hasPanels =
    state?.enhancements?.responsibilities === true ||
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
                  onClick={() => state && togglePause(!state.user.paused)}
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
                    {runs.length === 0 && !state?.tasks.length ? (
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
                                  {run.event.attachments?.length ? (
                                    <div className="mt-2 flex flex-wrap gap-2">
                                      {run.event.attachments.map((attachment) => (
                                        <Button
                                          key={attachment.attachmentId}
                                          variant="secondary"
                                          size="sm"
                                          onClick={() =>
                                            void downloadAttachment(attachment.attachmentId).catch(
                                              (cause) => reportError(cause, session.ownerToken),
                                            )
                                          }
                                        >
                                          {attachment.name}
                                        </Button>
                                      ))}
                                    </div>
                                  ) : (
                                    Boolean(run.event.attachmentIds?.length) && (
                                      <p className="mt-1 text-xs">
                                        {run.event.attachmentIds?.length} attached{" "}
                                        {run.event.attachmentIds?.length === 1 ? "file" : "files"}
                                      </p>
                                    )
                                  )}
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
                                <span id={`bot-run-${run.runId}`} tabIndex={-1} />
                                {run.result?.summary ??
                                  run.error ??
                                  (isPendingDotRun(run)
                                    ? run.event.kind === "responsibility"
                                      ? "Checking your followed task…"
                                      : "Message pending"
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
                                onSavePreference={
                                  state.enhancements?.memoryCorrection &&
                                  run.status === "completed" &&
                                  feedbackByRun.get(run.runId)?.rating
                                    ? () => setPreferenceRun(run.runId)
                                    : undefined
                                }
                              />
                            )}
                            {preferenceRun === run.runId && (
                              <BotMemoryEditor
                                sourceRunId={run.runId}
                                onSave={memoryEdit}
                                onCancel={() => setPreferenceRun(null)}
                              />
                            )}
                          </Fragment>
                        ))}
                        {state?.tasks.map((task) => (
                          <details
                            key={task.taskId}
                            id={`bot-task-${task.taskId}`}
                            tabIndex={-1}
                            className="rounded-xl border p-3 text-sm"
                          >
                            <summary className="cursor-pointer font-medium">
                              {task.title} · {task.status}
                            </summary>
                            <div className="mt-2 space-y-2">
                              {usableWaiting(task.waiting) && (
                                <BotWaitingStatus
                                  waiting={usableWaiting(task.waiting)!}
                                  subject={task.title}
                                  timezone={state.handling?.timezone}
                                />
                              )}
                              {state.enhancements?.resultCards && task.structuredResult ? (
                                <BotResultCard
                                  result={task.structuredResult}
                                  fullReply={task.result}
                                  onDownload={downloadAttachment}
                                />
                              ) : (
                                <p className="whitespace-pre-wrap break-words">
                                  {task.result ?? "A result has not been reported yet."}
                                </p>
                              )}
                            </div>
                          </details>
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
                        <div
                          key={approval.approvalId}
                          id={`bot-approval-${approval.approvalId}`}
                          tabIndex={-1}
                          className="mb-3 space-y-2 text-sm"
                        >
                          <p>{approval.summary}</p>
                          {approval.notStartable && (
                            <p role="status" className="text-xs">
                              Can't start: {approval.notStartable} Approving won't run it; decline
                              it and ask for an updated brief if it's still needed.
                            </p>
                          )}
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
                            {!approval.notStartable && (
                              <Button
                                size="sm"
                                disabled={busyApproval !== null || state?.user.paused}
                                onClick={() => void decide(approval.approvalId, true)}
                              >
                                Approve
                              </Button>
                            )}
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
                  <BotMemoryPanel
                    memories={state?.dotMemory ?? []}
                    editable={state?.enhancements?.memoryCorrection === true}
                    disabled={!connected}
                    onChange={(memory, action) =>
                      mutate((owner) => client.changeMemory(owner, memory, action))
                    }
                    onEdit={memoryEdit}
                    onRead={async (memoryId) => {
                      if (!session || activeOwner.current !== session.ownerToken)
                        throw new Error("Sign in again to continue.");
                      try {
                        const result = await client.readEditableMemory(session, memoryId);
                        if (activeOwner.current !== session.ownerToken || !mounted.current)
                          throw new Error("Your bot session changed. Sign in again to continue.");
                        if (
                          result.memory.memoryId !== memoryId ||
                          !Number.isSafeInteger(result.memory.version) ||
                          result.memory.version < 1 ||
                          result.memory.status !== "active"
                        )
                          throw new Error(
                            "The selected memory is no longer available for editing.",
                          );
                        return result;
                      } catch (cause) {
                        reportError(cause, session.ownerToken);
                        throw cause;
                      }
                    }}
                    sourceRuns={runs.map((run) => ({
                      runId: run.runId,
                      label: run.event.text ?? run.result?.summary ?? "Bot conversation",
                    }))}
                    onOpenSource={(runId) => openItem("run", runId)}
                  />
                  {state?.enhancements?.attachments && (
                    <div className="shrink-0 space-y-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          ref={fileInput}
                          type="file"
                          multiple
                          accept=".txt,.md,.csv,.json,.pdf,.docx,.png,.jpg,.jpeg,.webp"
                          aria-label="Choose files for your bot"
                          className="sr-only"
                          disabled={uploading || sending || !connected}
                          onChange={(event) => void attachFiles(event.currentTarget.files)}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={uploading || sending || !connected || attachments.length >= 3}
                          onClick={() => fileInput.current?.click()}
                        >
                          <PaperclipIcon className="size-3.5" />
                          {uploading ? "Uploading…" : "Attach files"}
                        </Button>
                        <span className="text-muted-foreground">
                          Up to 3 files · 4 MB each · documents or screenshots
                        </span>
                      </div>
                      {attachments.map((item) => (
                        <div key={item.attachmentId} className="flex flex-wrap items-center gap-2">
                          <span>
                            {item.name} · {Math.ceil(item.size / 1024)} KB
                            {item.truncated ? " · Only part of the text can be read" : ""}
                          </span>
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={uploading || sending}
                            aria-label={`Remove ${item.name}`}
                            onClick={() =>
                              setAttachments((current) =>
                                current.filter((value) => value.attachmentId !== item.attachmentId),
                              )
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                      {uploadStatus && (
                        <p role="status" className="text-muted-foreground">
                          {uploadStatus}
                        </p>
                      )}
                    </div>
                  )}
                  {replyTarget && (
                    <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
                      <span id="bot-reply-target">
                        Replying to “{replyTarget.title}”. Your message continues it once and never
                        approves an action.
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={sending}
                        onClick={() => setReplyTarget(null)}
                      >
                        Send as ordinary chat
                      </Button>
                    </div>
                  )}
                  {replyStatus && (
                    <p role="status" className="shrink-0 text-xs text-muted-foreground">
                      {replyStatus}
                    </p>
                  )}
                  <form
                    className="flex shrink-0 items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void send();
                    }}
                  >
                    <Input
                      nativeInput
                      ref={composerInput}
                      aria-describedby={replyTarget ? "bot-reply-target" : undefined}
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
                      disabled={
                        (!draft.trim() && !attachments.length) || sending || uploading || !connected
                      }
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
                      decisionInbox={state?.enhancements?.decisionInbox === true}
                      onOpen={handlingOpen}
                      canOpen={(item) => {
                        const target = handlingTarget(item);
                        return Boolean(
                          (target &&
                            (target.kind === "approval"
                              ? state?.approvals.some((value) => value.approvalId === target.id) ||
                                state?.enhancements?.decisionInbox
                              : target.kind === "run"
                                ? runs.some((value) => value.runId === target.id)
                                : target.kind === "task"
                                  ? state?.tasks.some((value) => value.taskId === target.id) ||
                                    state?.enhancements?.decisionInbox
                                  : target.kind === "routine"
                                    ? state?.scheduledPrompts?.some(
                                        (value) => value.promptId === target.id,
                                      )
                                    : state?.responsibilities?.some(
                                        (value) => value.responsibilityId === target.id,
                                      ))) ||
                          botWebUrl(item.source?.link),
                        );
                      }}
                      onSnooze={(item) => handlingResponsibility(item, "snooze")}
                      onResume={(item) => handlingResponsibility(item, "resume")}
                      onWaitingAction={waitingAction}
                    />
                    <BotRoutinesPanel
                      watches={state?.watches}
                      scheduledPrompts={state?.scheduledPrompts}
                      onPromptAction={promptAction}
                      editable={state?.enhancements?.routineEditor === true}
                      capabilities={state?.capabilities}
                      onSave={saveRoutine}
                      onPreview={(input) => {
                        if (!session)
                          return Promise.reject(new Error("Sign in again to continue."));
                        return client.previewRoutine(session, input);
                      }}
                    />
                    {state?.enhancements?.fileRecipes && (
                      <BotFileRecipesPanel
                        recipes={state.fileRecipes ?? []}
                        approvals={state.approvals}
                        tasks={state.tasks}
                        oneDriveConnected={(() => {
                          const capability = state.capabilities?.find(
                            (item) => item.id === "onedrive",
                          );
                          return capability
                            ? capability.availability.status === "available"
                            : undefined;
                        })()}
                        onBrowse={(folderId) => {
                          if (!session)
                            return Promise.reject(new Error("Sign in again to continue."));
                          return client.recipeFolders(session, folderId);
                        }}
                        onCreate={createFileRecipe}
                        onEdit={(recipe, input) =>
                          mutate((owner) => client.editFileRecipe(owner, recipe, input))
                        }
                        onAction={(recipe, action) =>
                          mutate((owner) => client.fileRecipeAction(owner, recipe, action))
                        }
                        onStart={(recipe, event) =>
                          mutate(async (owner) => {
                            const started = await client.startFileRecipeEvent(
                              owner,
                              recipe.recipeId,
                              event.key,
                            );
                            acceptedRunIds.current.add(started.runId);
                            return started;
                          })
                        }
                        onWaitingAction={waitingAction}
                      />
                    )}
                    {state?.enhancements?.responsibilities && (
                      <BotResponsibilitiesPanel
                        responsibilities={state.responsibilities ?? []}
                        tasks={state.tasks.filter((task) => task.detail?.kind === "harness-task")}
                        replies={state.enhancements?.replyContinuation === true}
                        runs={state.runs}
                        onAction={responsibilityAction}
                        onOpen={(taskId) => openItem("task", taskId)}
                        onLoadTask={loadTaskEvidence}
                        onReply={(item) => {
                          setReplyTarget({ id: item.responsibilityId, title: item.title });
                          setReplyStatus(null);
                          composerInput.current?.focus();
                        }}
                        onWaitingAction={waitingAction}
                      />
                    )}
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
  onSavePreference,
}: {
  readonly onSavePreference?: (() => void) | undefined;
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
      {onSavePreference && (
        <Button variant="ghost" size="compact" disabled={disabled} onClick={onSavePreference}>
          Save a preference…
        </Button>
      )}
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
