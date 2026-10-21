import type { OrchestrationV2ContextHandoff, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { renderHistory } from "@t3tools/provider-core/server/handoffBudget";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TeamMessageGate from "./TeamMessageGate.ts";

/**
 * A refused turn stays in local history. Do not let recovery of its failed run
 * become a second, unchecked route to the provider. Already delivered history
 * stays as history; this only withholds user text the provider never accepted.
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
        ProjectionStore.ProjectionRecords<"runs" | "messages" | "attempts" | "providerTurns">
      >();
      for (const [threadId, ids] of runIdsByThread)
        sources.set(
          threadId,
          yield* projections.getThreadRecords(
            threadId,
            ["runs", "messages", "attempts", "providerTurns"],
            { runIds: [...ids], messageRunIds: [...ids] },
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
            if (
              run &&
              run.status !== "failed" &&
              run.status !== "interrupted" &&
              run.status !== "cancelled"
            ) {
              messages.push(message);
              continue;
            }
            const attempts = new Set(
              source.attempts
                .filter((attempt) => attempt.runId === message.runId)
                .map((attempt) => attempt.id),
            );
            if (
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
            const original = source.messages.find(
              (candidate) => candidate.id === run?.userMessageId,
            );
            // Missing source data cannot authorize replay of a failed user message.
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
