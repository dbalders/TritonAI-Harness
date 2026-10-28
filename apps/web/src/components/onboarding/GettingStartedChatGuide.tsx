import type { EnvironmentId, OrchestrationV2RunStatus, ThreadId } from "@t3tools/contracts";
import type { InlineSkill } from "@t3tools/shared/inlineSkills";
import { useNavigate } from "@tanstack/react-router";
import { BookOpenIcon, CheckIcon, LifeBuoyIcon, MessageCircleIcon } from "lucide-react";
import { useEffect } from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { TimelineEntry } from "../../session-logic";
import {
  gettingStartedRunEvents,
  type GettingStartedRun,
} from "../../onboarding/gettingStartedEvidence";
import { mergeIdeaPrompt } from "../ideas/ideaDraft";
import {
  prepareGettingStartedHelp,
  useGettingStarted,
  useGettingStartedEnabled,
  updateGettingStarted,
} from "../../onboarding/gettingStartedState";
import { GETTING_STARTED_CHAPTERS } from "../../onboarding/gettingStarted.logic";
import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";

interface GuideChatInput {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  runs: ReadonlyArray<GettingStartedRun>;
  run: {
    runId: string;
    status: OrchestrationV2RunStatus;
    startedAt?: string | null;
    requestedAt?: string | null;
  } | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  answeredRunIds: ReadonlySet<string>;
  isWorking: boolean;
  hasPendingApproval: boolean;
  hasPendingQuestion: boolean;
  skills: ReadonlyArray<InlineSkill>;
}

export function useGettingStartedChatGuide(input: GuideChatInput): ComposerBannerStackItem | null {
  const state = useGettingStarted();
  const enabled = useGettingStartedEnabled();
  const navigate = useNavigate();
  const { environmentId, threadId, run, runs, timelineEntries, answeredRunIds, skills } = input;
  const task = state.tasks.find(
    (item) =>
      item.chapter === state.activeChapter &&
      item.environmentId === environmentId &&
      item.threadId === threadId,
  );
  useEffect(() => {
    if (!enabled || !threadId) return;
    for (const event of gettingStartedRunEvents({
      state,
      environmentId,
      threadId,
      runs,
      timelineEntries,
      answeredRunIds,
      skills,
    })) {
      void updateGettingStarted(event);
    }
  }, [answeredRunIds, enabled, environmentId, runs, skills, state, threadId, timelineEntries]);

  if (
    !enabled ||
    !task ||
    !state.startedAt ||
    state.paused ||
    state.environmentId !== environmentId
  )
    return null;
  const complete = state.completed.includes(task.chapter);
  const failed = run !== null && ["failed", "interrupted", "cancelled"].includes(run.status);
  const prepareFollowUp = () => {
    if (!threadId) return;
    const ref = scopeThreadRef(environmentId, threadId);
    const store = useComposerDraftStore.getState();
    store.setPrompt(
      ref,
      mergeIdeaPrompt(
        store.getComposerDraft(ref)?.prompt ?? "",
        "Which tasks have no deadline in the original notes?",
      ),
    );
  };
  let title = "Review the request, then send when you're ready";
  let description =
    "This is the regular composer. You can edit the request before anything is sent.";
  if (input.hasPendingApproval) {
    title = "Review what it wants to do";
    description = "This action needs your approval. Read the details, then approve or decline it.";
  } else if (input.hasPendingQuestion) {
    title = "It needs a little more context";
    description = "Answer the question below to help it continue.";
  } else if (input.isWorking) {
    title = "Your assistant is working";
    description = "Watch its activity below. The stop control lets you interrupt the task.";
  } else if (failed) {
    title = "This task hasn't finished yet";
    description = "Your progress is saved. Review the error and try again here when you're ready.";
  } else if (complete) {
    title = "You've put this chapter into practice";
    description =
      "Keep using this conversation, or open your chapters for the next useful thing to try.";
  } else if (task.chapter === "conversation" && task.runIds.length === 1) {
    title = "Keep the conversation going";
    description =
      "You can add context or ask for a change in this same conversation. Prepare a follow-up, then send it yourself.";
  } else if (task.chapter === "conversation" && task.runIds.length >= 2) {
    title = "Give the answer a quick check";
    description =
      "The original practice notes give only Dev a deadline: Friday. Kim's and Jordan's dates should be marked as missing. AI can make mistakes.";
  } else if (task.chapter === "files") {
    description =
      "Use the paperclip to attach a suitable file, then ask about it. The guide waits for an attached-file request to finish.";
  } else if (task.chapter === "connected-work" && task.toolNames.length === 0) {
    description =
      "These practice emails are made up, so nothing personal is shared. Send the request, and connect your own email later when you're ready.";
  } else if (task.chapter === "connected-work" && task.runIds.length === 0) {
    description =
      "Ask a small question about your connected email. This chapter completes after a relevant email tool runs successfully and you receive an answer.";
  } else if (task.chapter === "approvals") {
    description =
      "Send this request. Saving a file changes your computer, so it stops and asks you first. Approve or decline; either choice completes the chapter.";
  } else if (task.chapter === "skills") {
    description =
      "The $ name at the start picks the skill. Send the request to see what the skill can do for you.";
  }
  return {
    id: "getting-started",
    variant: "info",
    group: "attention",
    icon: complete ? <CheckIcon /> : <MessageCircleIcon />,
    title,
    description,
    dismissLabel: "Pause getting started guidance",
    onDismiss: () => void updateGettingStarted({ type: "pause" }),
    children: (
      <div className="flex flex-wrap items-center gap-2">
        {task.chapter === "conversation" && task.runIds.length === 1 && !input.isWorking ? (
          <Button size="xs" variant="outline" onClick={prepareFollowUp}>
            Prepare a follow-up
          </Button>
        ) : null}
        {task.chapter === "conversation" && task.runIds.length >= 2 && !complete ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              threadId &&
              void updateGettingStarted({
                type: "checked-source",
                environmentId,
                threadId,
                generation: state.generation,
              })
            }
          >
            I've checked against the notes
          </Button>
        ) : null}
        {failed ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              prepareGettingStartedHelp(environmentId, task.chapter);
              void navigate({ to: "/help" });
            }}
          >
            <LifeBuoyIcon />
            Ask Help
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() =>
            void updateGettingStarted({
              type: "select",
              chapter: complete
                ? (GETTING_STARTED_CHAPTERS[
                    GETTING_STARTED_CHAPTERS.findIndex((item) => item.id === state.activeChapter) +
                      1
                  ]?.id ?? "ready")
                : state.activeChapter,
            })
          }
        >
          <BookOpenIcon />
          {complete ? "Next chapter" : "Your chapters"}
        </Button>
      </div>
    ),
  };
}
