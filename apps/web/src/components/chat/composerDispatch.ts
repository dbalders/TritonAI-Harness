import type { SessionPhase } from "../../types";

export type ActiveTurnComposerAction = "queue" | "steer";
export type ComposerDispatchMode = "auto" | ActiveTurnComposerAction;

export function resolveQueuedDispatchTarget<T extends { readonly threadKey: string }>(
  threadKey: string,
  target: T | null,
): T | null {
  return target?.threadKey === threadKey ? target : null;
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
