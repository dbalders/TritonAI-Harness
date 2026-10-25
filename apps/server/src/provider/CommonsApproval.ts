// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalDate:off -- Connection-owned nonces and synchronous admission checks must not await a runtime.
import {
  ServerTritonAiCommonsError,
  type AuthSessionId,
  type ServerCommonsApprovalState,
  type ServerRespondCommonsApprovalInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";
import {
  installSettingsIntegrationWriteGate,
  type IntegrationSettingsApprovalOwner,
  type IntegrationWriteReview,
} from "../integrations/IntegrationWriteApproval.ts";

interface PendingReview {
  readonly review: IntegrationWriteReview;
  readonly resolve: (approved: boolean) => void;
}
interface Submission {
  readonly owner: IntegrationSettingsApprovalOwner;
  readonly controller: AbortController;
  live: boolean;
  pending: PendingReview | null;
  presenter: Disposable | null;
}

const refusal = (message: string) =>
  new ServerTritonAiCommonsError({ code: "approval_required", message });
const cancelled = () =>
  new ServerTritonAiCommonsError({
    code: "cancelled",
    message:
      "Sharing was cancelled. An already admitted change may still finish; retry to reconcile it.",
  });

/** One authenticated WebSocket connection owns this presenter and every submission it starts. */
export const makeCommonsApproval = Effect.fn("CommonsApproval.make")(function* (input: {
  readonly sessionId: AuthSessionId;
  readonly expiresAt?: number;
}) {
  const clock = yield* Clock.Clock;
  const connectionId = NodeCrypto.randomUUID();
  const state = yield* SubscriptionRef.make<ServerCommonsApprovalState | null>(null);
  let closed = false;
  let reviewCapable = false;
  let current: Submission | null = null;
  const isCurrent = (entry: Submission) =>
    !closed &&
    current === entry &&
    entry.live &&
    !entry.controller.signal.aborted &&
    (input.expiresAt === undefined || clock.currentTimeMillisUnsafe() < input.expiresAt);

  const finish = Effect.fn("CommonsApproval.finish")(function* (entry: Submission) {
    entry.live = false;
    entry.controller.abort();
    entry.pending?.resolve(false);
    entry.presenter?.[Symbol.dispose]();
    if (current === entry) {
      current = null;
      yield* SubscriptionRef.set(state, null);
    }
  });

  const reviewWrite = Effect.fn("CommonsApproval.reviewWrite")(function* (
    entry: Submission,
    review: IntegrationWriteReview,
  ) {
    if (!isCurrent(entry) || entry.pending !== null) return { approved: false } as const;
    const answer = Promise.withResolvers<boolean>();
    const pending = { review, resolve: answer.resolve };
    entry.pending = pending;
    const expiresAt = Math.min(review.expiresAt, input.expiresAt ?? review.expiresAt);
    yield* SubscriptionRef.set(state, {
      submissionId: entry.owner.submissionId,
      review: {
        requestId: review.requestId,
        integrationName: review.integrationName,
        toolName: review.toolName,
        accountLabel: review.accountLabel,
        connection: review.connection,
        submittedDigest: review.submittedDigest,
        effectiveDigest: review.effectiveDigest,
        payload: review.payload,
        expiresAt,
      },
    });
    const result = yield* Effect.promise(() => answer.promise).pipe(
      Effect.timeoutOption(Math.max(0, expiresAt - clock.currentTimeMillisUnsafe())),
      Effect.ensuring(
        Effect.gen(function* () {
          if (entry.pending === pending) entry.pending = null;
          if (isCurrent(entry))
            yield* SubscriptionRef.set(state, {
              submissionId: entry.owner.submissionId,
              review: null,
            });
        }),
      ),
    );
    return Option.isSome(result) && result.value && isCurrent(entry)
      ? ({ approved: true, isCurrent: () => isCurrent(entry) } as const)
      : ({ approved: false } as const);
  });

  const start = Effect.fn("CommonsApproval.start")(function* () {
    if (!reviewCapable)
      return yield* refusal(
        "Update this client to review each exact sharing write before submitting.",
      );
    if (
      closed ||
      current !== null ||
      (input.expiresAt !== undefined && clock.currentTimeMillisUnsafe() >= input.expiresAt)
    )
      return yield* refusal(
        "This connection cannot start another sharing review. Finish or cancel its current submission.",
      );
    const entry: Submission = {
      owner: Object.freeze({
        kind: "settings",
        sessionId: input.sessionId,
        connectionId,
        submissionId: NodeCrypto.randomUUID(),
      }),
      controller: new AbortController(),
      live: true,
      pending: null,
      presenter: null,
    };
    current = entry;
    entry.presenter = installSettingsIntegrationWriteGate(entry.owner, (review) =>
      reviewWrite(entry, review),
    );
    yield* SubscriptionRef.set(state, { submissionId: entry.owner.submissionId, review: null });
    return entry;
  });

  const awaitCancel = (entry: Submission) =>
    Effect.callback<never, ServerTritonAiCommonsError>((resume) => {
      const abort = () => resume(Effect.fail(cancelled()));
      if (entry.controller.signal.aborted) abort();
      else entry.controller.signal.addEventListener("abort", abort, { once: true });
      return Effect.sync(() => entry.controller.signal.removeEventListener("abort", abort));
    });

  return {
    changes: SubscriptionRef.changes(state).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          reviewCapable = true;
        }),
      ),
    ),
    run: <A, E, R>(
      operation: (owner: IntegrationSettingsApprovalOwner) => Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        start(),
        (entry) => Effect.raceFirst(operation(entry.owner), awaitCancel(entry)),
        finish,
      ),
    respond: Effect.fn("CommonsApproval.respond")(function* (
      response: ServerRespondCommonsApprovalInput,
    ) {
      const entry = current;
      if (entry === null || !isCurrent(entry) || entry.owner.submissionId !== response.submissionId)
        return yield* refusal("This sharing review is no longer owned by this connection.");
      if (response.action.type === "cancel") {
        entry.live = false;
        entry.controller.abort();
        entry.pending?.resolve(false);
        return;
      }
      const pending = entry.pending;
      if (
        pending === null ||
        pending.review.requestId !== response.action.requestId ||
        clock.currentTimeMillisUnsafe() >= pending.review.expiresAt
      )
        return yield* refusal("This exact sharing request is no longer awaiting a decision.");
      entry.pending = null;
      pending.resolve(response.action.decision === "accept");
    }),
    close: Effect.fn("CommonsApproval.close")(function* () {
      closed = true;
      if (current !== null) yield* finish(current);
    }),
  };
});
