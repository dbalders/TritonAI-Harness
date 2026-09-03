import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { applyClaudePromptEffortPrefix, resolvePromptInjectedEffort } from "@t3tools/shared/model";

import { getProviderModelCapabilities } from "../../providerModels";
import type { SessionPhase } from "../../types";

export type ActiveTurnComposerAction = "queue" | "steer";
export type ComposerDispatchMode = "auto" | ActiveTurnComposerAction;

export function formatOutgoingPrompt(params: {
  provider: ProviderDriverKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  const promptEffort = resolvePromptInjectedEffort(caps, params.effort);
  return applyClaudePromptEffortPrefix(params.text, promptEffort);
}

export function resolveComposerDispatchMode(input: {
  readonly phase: SessionPhase;
  readonly activeTurnDefault: ActiveTurnComposerAction;
  readonly inverseModifier: boolean;
}): ComposerDispatchMode {
  if (input.phase !== "running") return "auto";
  if (!input.inverseModifier) return input.activeTurnDefault;
  return input.activeTurnDefault === "queue" ? "steer" : "queue";
}

export function queuedDispatchBlocksComposer(input: {
  readonly phase: SessionPhase;
  readonly dispatchInFlight: boolean;
}): boolean {
  // Once the queued turn is running, keep its acknowledgement barrier without
  // disabling the active-turn Queue and Steer actions.
  return input.dispatchInFlight && input.phase !== "running";
}

export function isQueuedMessageTurnComplete(input: {
  readonly messageProjected: boolean;
  readonly previousTurnId: string | null | undefined;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: "running" | "interrupted" | "completed" | "error";
  } | null;
}): boolean {
  return (
    input.messageProjected &&
    input.latestTurn != null &&
    input.latestTurn.turnId !== input.previousTurnId &&
    input.latestTurn.state !== "running"
  );
}

export function resolveQueuedAcknowledgement(input: {
  readonly phase: SessionPhase;
  readonly messageProjected: boolean;
  readonly previousTurnId: string | null | undefined;
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: "running" | "interrupted" | "completed" | "error";
  } | null;
  readonly deadlineAt: number | undefined;
  readonly now: number;
}): "waiting" | "complete" | "expired" {
  if (input.phase !== "ready") return "waiting";
  if (isQueuedMessageTurnComplete(input)) return "complete";
  return input.deadlineAt !== undefined && input.now >= input.deadlineAt ? "expired" : "waiting";
}

export function canAutoDrainComposerQueue(input: {
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly isThreadDetailLoading: boolean;
  readonly hasPendingUserInput: boolean;
  readonly awaitingPreviousMessageAcknowledgement: boolean;
  readonly firstEntryStatus: "queued" | "dispatching" | "failed" | null;
}): boolean {
  return (
    input.phase === "ready" &&
    !input.isSendBusy &&
    !input.isConnecting &&
    !input.isThreadDetailLoading &&
    !input.hasPendingUserInput &&
    !input.awaitingPreviousMessageAcknowledgement &&
    input.firstEntryStatus === "queued"
  );
}
