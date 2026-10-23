import type { OrchestrationV2ContextHandoff, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { renderHistory } from "@t3tools/provider-core/server/handoffBudget";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TeamMessageGate from "./TeamMessageGate.ts";

/**
 * A refused turn stays in local history. Do not let recovery of its failed run
 * become a second, unchecked route to the provider. Already delivered history
 * stays as history when its delivery can be established. Steering has no
 * per-message acceptance receipt, so it must pass its own access check again.
 */
export const makeFilter = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const gate = yield* TeamMessageGate.TeamMessageGate;
  return (handoffs: readonly OrchestrationV2ContextHandoff[]) =>
    Effect.gen(function* () {
      // Read each source once, with only the runs/messages this delivery may replay.
      const runIdsByThread = new Map<ThreadId, Set<RunId>>();
      for (const handoff of handoffs)
        for (const message of handoff.history?.messages ?? []) {
          if (message.role !== "user" || message.runId === null) continue;
          const ids = runIdsByThread.get(message.threadId) ?? new Set<RunId>();
          ids.add(message.runId);
          runIdsByThread.set(message.threadId, ids);
        }
      const sources = new Map<
        ThreadId,
        ProjectionStore.ProjectionRecords<
          "runs" | "messages" | "turnItems" | "attempts" | "providerTurns"
        >
      >();
      for (const [threadId, ids] of runIdsByThread)
        sources.set(
          threadId,
          yield* projections.getThreadRecords(
            threadId,
            ["runs", "messages", "turnItems", "attempts", "providerTurns"],
            {
              runIds: [...ids],
              messageRunIds: [...ids],
              messageRoles: ["user"],
              turnItemRunIds: [...ids],
              turnItemTypes: ["user_message"],
            },
          ),
        );
      return yield* Effect.forEach(handoffs, (handoff) =>
        Effect.gen(function* () {
          if (!handoff.history) return handoff;
          const messages = [];
          const omitted = [];
          for (const message of handoff.history.messages) {
            if (message.role !== "user" || message.runId === null) {
              messages.push(message);
              continue;
            }
            const source = sources.get(message.threadId)!;
            const run = source.runs.find((candidate) => candidate.id === message.runId);
            const item = source.turnItems.find(
              (candidate) =>
                candidate.id === message.itemId &&
                candidate.runId === message.runId &&
                candidate.type === "user_message",
            );
            const original =
              item?.type === "user_message"
                ? source.messages.find(
                    (candidate) =>
                      candidate.id === item.messageId &&
                      candidate.runId === message.runId &&
                      candidate.nodeId === item.nodeId &&
                      candidate.role === "user",
                  )
                : undefined;
            const attempts = new Set(
              source.attempts
                .filter(
                  (attempt) =>
                    attempt.runId === message.runId && attempt.rootNodeId === original?.nodeId,
                )
                .map((attempt) => attempt.id),
            );
            if (
              original !== undefined &&
              original.id === run?.userMessageId &&
              source.providerTurns.some(
                (turn) =>
                  turn.runAttemptId !== null &&
                  attempts.has(turn.runAttemptId) &&
                  (turn.nativeTurnRef !== null || turn.startedAt !== null),
              )
            ) {
              messages.push(message);
              continue;
            }
            // Missing source data cannot authorize replay of an unaccepted user message.
            if (
              !original ||
              (yield* Effect.result(
                gate.verifyBeforeSend({
                  messageId: original.id,
                  threadId: message.threadId,
                  text: original.text,
                }),
              ))._tag === "Failure"
            ) {
              omitted.push(message.itemId);
              continue;
            }
            messages.push(message);
          }
          if (omitted.length === 0) return handoff;
          const history = {
            ...handoff.history,
            messages,
            omittedItems: handoff.history.omittedItems + omitted.length,
            omittedItemIds: [...(handoff.history.omittedItemIds ?? []), ...omitted],
          };
          return {
            ...handoff,
            history,
            summaryText: renderHistory(history.messages, history.coverage),
          };
        }),
      );
    });
});
