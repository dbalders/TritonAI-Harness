import type { EnvironmentId, OrchestrationV2RunStatus, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  FileTextIcon,
  LightbulbIcon,
  LockIcon,
  MessageCircleQuestionIcon,
  PencilLineIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  onboardingProgressLines,
  onboardingRole,
  onboardingTask,
  type OnboardingFollowUp,
  type OnboardingWorkLogEntry,
} from "../../onboarding/guidedOnboarding.logic";
import { updateGuidedTourState, useGuidedTourState } from "../../onboarding/guidedTourState";
import type { TimelineEntry } from "../../session-logic";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

const FAILED_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "failed",
  "interrupted",
  "cancelled",
]);

export interface GuidedTourChatGuideInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly run: {
    readonly runId: string;
    readonly status: OrchestrationV2RunStatus;
    readonly startedAt?: string | null | undefined;
    readonly requestedAt?: string | null | undefined;
  } | null;
  readonly isWorking: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingQuestion: boolean;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  /** Sends through the chat's own send path; resolves false when it did not send. */
  readonly send: (text: string) => Promise<boolean>;
}

/** The work it did in the current run, in the shape the progress lines read. */
function runWorkLog(
  entries: ReadonlyArray<TimelineEntry>,
  runId: string,
): ReadonlyArray<OnboardingWorkLogEntry> {
  return entries.flatMap((item) =>
    item.kind === "work" && item.entry.runId === runId
      ? [
          {
            label: item.entry.label,
            toolTitle: item.entry.toolTitle,
            command: item.entry.command,
            changedFiles: item.entry.changedFiles,
            integrationTool: item.entry.toolSource?.kind === "integration",
          },
        ]
      : [],
  );
}

/**
 * The last thing the person asked, which "Try again" sends again. A retry is text only,
 * so a message that carried a file can't be repeated this way.
 */
function latestUserMessageText(entries: ReadonlyArray<TimelineEntry>): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.kind === "message" && entry.message.role === "user") {
      return (entry.message.attachments?.length ?? 0) > 0 ? null : entry.message.text;
    }
  }
  return null;
}

/** Ticks on its own so ChatView never re-renders once a second for the timer. */
function ElapsedSeconds({ since }: { readonly since: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const started = since ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  // Hidden from screen readers: banners are live regions, and a ticking count would be
  // read out every second.
  return (
    <span aria-hidden="true" className="ml-1.5 font-normal tabular-nums text-muted-foreground">
      {seconds}s
    </span>
  );
}

function followUpIcon(kind: OnboardingFollowUp["kind"]): ReactNode {
  if (kind === "draft") return <PencilLineIcon />;
  if (kind === "save") return <FileTextIcon />;
  return <ArrowRightIcon />;
}

const dismiss = () => updateGuidedTourState({ chatGuideDismissed: true });

/**
 * The experimental tour's last part: a notice above the composer in the conversation its
 * first task runs in. While the answer is on its way it says what is happening, from the
 * run's real activity; afterwards it offers follow-ups, so the first thing someone
 * learns is that they can keep talking to it.
 */
export function useGuidedTourChatGuide(
  input: GuidedTourChatGuideInput,
): ComposerBannerStackItem | null {
  const enabled = useClientSettings((settings) => settings.experimentalGuidedTourEnabled);
  const tour = useGuidedTourState();
  const [sending, setSending] = useState(false);
  const active =
    enabled &&
    !tour.chatGuideDismissed &&
    input.threadId !== null &&
    tour.taskThreadId === input.threadId &&
    tour.taskEnvironmentId === input.environmentId;
  const { run, isWorking, hasPendingApproval, hasPendingQuestion, timelineEntries, send } = input;
  const runId = run?.runId ?? null;
  const stopped = run !== null && FAILED_RUN_STATUSES.has(run.status);
  const progress = useMemo(
    () =>
      active && isWorking && runId
        ? onboardingProgressLines(runWorkLog(timelineEntries, runId))
        : [],
    [active, isWorking, runId, timelineEntries],
  );
  const latestUserMessage = useMemo(
    () => (active && stopped ? latestUserMessageText(timelineEntries) : null),
    [active, stopped, timelineEntries],
  );

  const sendOnce = useStableCallback(async (text: string, onSent?: () => void) => {
    if (sending) return;
    setSending(true);
    try {
      if (await send(text)) onSent?.();
    } finally {
      setSending(false);
    }
  });

  return useMemo<ComposerBannerStackItem | null>(() => {
    if (!active || input.threadId === null) return null;
    const id = `guided-tour:${input.threadId}`;
    const shared = { id, dismissLabel: "Hide tour suggestions", onDismiss: dismiss } as const;

    if (hasPendingApproval) {
      return {
        ...shared,
        variant: "info",
        priority: "urgent",
        icon: <LockIcon />,
        title: "It's asking before it does something",
        description:
          "Choose Approve to let it, or Decline to say no. Nothing happens until you do.",
      };
    }
    if (hasPendingQuestion) {
      return {
        ...shared,
        variant: "info",
        priority: "urgent",
        icon: <MessageCircleQuestionIcon />,
        title: "It has a question for you",
        description: "Answer it below to keep going.",
      };
    }
    if (isWorking) {
      return {
        ...shared,
        variant: "default",
        priority: "activity",
        icon: <Spinner />,
        title: (
          <>
            Working on it
            <ElapsedSeconds since={run?.startedAt ?? run?.requestedAt ?? null} />
          </>
        ),
        description: "You can stop it anytime with the stop button.",
        children:
          progress.length > 0 ? (
            <ul className="grid gap-1 text-sm">
              {progress.map((line, index) => (
                <li
                  key={line}
                  className={
                    index === progress.length - 1
                      ? "flex items-center gap-2 text-foreground"
                      : "flex items-center gap-2 text-muted-foreground"
                  }
                >
                  {index === progress.length - 1 ? (
                    <ArrowRightIcon className="size-3.5 shrink-0 text-primary" />
                  ) : (
                    <CheckIcon
                      className="size-3.5 shrink-0 text-success-foreground"
                      strokeWidth={3}
                    />
                  )}
                  {line}
                </li>
              ))}
            </ul>
          ) : undefined,
      };
    }
    if (run && stopped) {
      return {
        ...shared,
        variant: "warning",
        icon: <RotateCcwIcon />,
        title: "It stopped before finishing",
        description: latestUserMessage
          ? run.status === "failed"
            ? "Something went wrong on its side. You can send the same request again."
            : "You can send the same request again, or ask it something else below."
          : "Ask it again below. If you used your own file, attach it again with the paperclip.",
        actions: latestUserMessage ? (
          <Button
            size="xs"
            variant="outline"
            disabled={sending}
            onClick={() => void sendOnce(latestUserMessage)}
          >
            {sending ? <Spinner /> : <RotateCcwIcon />}
            Try again
          </Button>
        ) : undefined,
      };
    }
    if (run?.status !== "completed") return null;

    const role = onboardingRole(tour.roleId);
    const task = onboardingTask(role, tour.taskId);
    const followUps = (task?.followUps ?? []).filter(
      (item) => !tour.usedFollowUps.includes(item.label),
    );
    return {
      ...shared,
      variant: "default",
      priority: "notice",
      icon: <LightbulbIcon />,
      title: "Keep going",
      description:
        followUps.length > 0
          ? "Ask a follow-up the way you'd message a coworker, or try one of these."
          : "Ask a follow-up the way you'd message a coworker.",
      children: (
        <div className="grid gap-2">
          {followUps.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {followUps.map((followUp) => (
                <Button
                  key={followUp.label}
                  size="xs"
                  variant="outline"
                  disabled={sending}
                  onClick={() =>
                    void sendOnce(followUp.prompt, () =>
                      updateGuidedTourState({
                        usedFollowUps: [...tour.usedFollowUps, followUp.label],
                      }),
                    )
                  }
                >
                  {followUpIcon(followUp.kind)}
                  {followUp.label}
                </Button>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {followUps.some((item) => item.kind === "save") ? "Saving a file asks you first. " : ""}
            Connect email, calendar and files anytime in{" "}
            <Link to="/settings/plugins" className="underline underline-offset-2">
              Settings → Plugins
            </Link>
            .
          </p>
        </div>
      ),
    };
  }, [
    active,
    hasPendingApproval,
    hasPendingQuestion,
    input.threadId,
    isWorking,
    latestUserMessage,
    progress,
    run,
    sendOnce,
    sending,
    stopped,
    tour.roleId,
    tour.taskId,
    tour.usedFollowUps,
  ]);
}
