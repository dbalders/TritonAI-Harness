import type {
  EnvironmentId,
  GettingStartedProgress,
  OrchestrationV2RunStatus,
  ThreadId,
} from "@t3tools/contracts";
import { compactDynamicToolOutput, toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";
import { workEntryIndicatesToolSuccess, type TimelineEntry } from "../session-logic";
import { reduceGettingStarted, type GettingStartedEvent } from "./gettingStarted.logic";

export interface GettingStartedRun {
  runId: string;
  status: OrchestrationV2RunStatus;
  userMessageId: string;
  startedAt?: string | null;
  requestedAt?: string | null;
}

function matchesTool(actual: string, declared: string): boolean {
  const canonical = declared.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    canonical.length > 0 &&
    (actual === declared ||
      actual
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .endsWith(canonical))
  );
}

/** Read each run's own evidence, including completed runs behind a queued follow-up. */
export function gettingStartedRunEvents(input: {
  state: GettingStartedProgress;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  runs: ReadonlyArray<GettingStartedRun>;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}): GettingStartedEvent[] {
  const { state, environmentId, threadId, runs, timelineEntries } = input;
  let progress = state;
  const events: GettingStartedEvent[] = [];
  for (const run of runs) {
    if (run.status !== "completed") continue;
    const pending = progress.tasks.filter(
      (task) =>
        task.environmentId === environmentId &&
        task.threadId === threadId &&
        !progress.completed.includes(task.chapter) &&
        task.runIds.length < 2 &&
        !task.runIds.includes(run.runId) &&
        task.messageIds.includes(run.userMessageId),
    );
    if (pending.length === 0) continue;
    const hasAnswer = timelineEntries.some(
      (item) =>
        item.kind === "message" &&
        item.message.role === "assistant" &&
        item.message.runId === run.runId &&
        !item.message.streaming &&
        item.message.text.trim().length > 0,
    );
    if (!hasAnswer) continue;
    const allowedTools = pending
      .filter((task) => task.chapter === "connected-work")
      .flatMap((task) => task.toolNames);
    const connectedToolSucceeded = timelineEntries.some((item) => {
      if (
        item.kind !== "work" ||
        item.entry.runId !== run.runId ||
        item.entry.toolLifecycleStatus !== "completed" ||
        !workEntryIndicatesToolSuccess(item.entry)
      )
        return false;
      const tool = item.entry.structuredPayload;
      return (
        tool?.type === "dynamic_tool" &&
        tool.toolName !== null &&
        !compactDynamicToolOutput(tool.output)?.isError &&
        !(typeof tool.output === "string" && toolOutputIndicatesFailure(tool.output)) &&
        allowedTools.some((name) => matchesTool(tool.toolName ?? "", name))
      );
    });
    const userMessage = timelineEntries.find(
      (item) => item.kind === "message" && item.message.id === run.userMessageId,
    );
    const usedFile =
      userMessage?.kind === "message" &&
      (userMessage.message.attachments ?? []).some((attachment) => attachment.type === "file");
    const event: GettingStartedEvent = {
      type: "run",
      environmentId,
      threadId,
      runId: run.runId,
      userMessageId: run.userMessageId,
      startedAt: run.startedAt ?? run.requestedAt ?? "",
      succeeded: true,
      hasAnswer,
      connectedToolSucceeded,
      usedFile,
      generation: state.generation,
    };
    // Rejected evidence can become usable later; do not queue a settings write for it.
    const next = reduceGettingStarted(progress, event);
    if (next !== progress) {
      events.push(event);
      progress = next;
    }
  }
  return events;
}
