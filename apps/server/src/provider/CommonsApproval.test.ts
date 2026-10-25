import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  ServerTritonAiCommonsError,
  type ServerCommonsApprovalState,
  type ServerCommonsWriteReview,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeCommonsApproval } from "./CommonsApproval.ts";
import {
  requestIntegrationWriteApproval,
  type IntegrationSettingsApprovalOwner,
  type IntegrationWriteDecision,
} from "../integrations/IntegrationWriteApproval.ts";

type Presenter = Effect.Success<ReturnType<typeof makeCommonsApproval>>;
const nextReview = (presenter: Presenter, previous?: string) =>
  presenter.changes.pipe(
    Stream.filter(
      (value): value is ServerCommonsApprovalState & { review: ServerCommonsWriteReview } =>
        value !== null && value.review !== null && value.review.requestId !== previous,
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
const sampleReview = (owner: IntegrationSettingsApprovalOwner, id: string, now: number) => ({
  owner,
  requestId: id,
  integrationId: "github",
  integrationName: "GitHub",
  accountLabel: "Synthetic contributor",
  connection: "synthetic-connection-epoch",
  toolName: "github.contents.put",
  submittedDigest: `submitted-${id}`,
  effectiveDigest: `effective-${id}`,
  payload: `{"content": "${"line ".repeat(1_000)}${id} final tail"}`,
  expiresAt: now + 1_000,
});

it.effect("requires a review-capable client before any Settings submission starts", () =>
  Effect.gen(function* () {
    const presenter = yield* makeCommonsApproval({
      sessionId: AuthSessionId.make("synthetic-session"),
    });
    let started = false;
    const result = yield* presenter
      .run(() =>
        Effect.sync(() => {
          started = true;
        }),
      )
      .pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    expect(started).toBe(false);
  }),
);

it.effect(
  "requires a fresh exact decision for each write and rejects another connection and replay",
  () =>
    Effect.gen(function* () {
      const presenter = yield* makeCommonsApproval({
        sessionId: AuthSessionId.make("synthetic-session"),
      });
      const other = yield* makeCommonsApproval({
        sessionId: AuthSessionId.make("synthetic-session"),
      });
      yield* presenter.changes.pipe(Stream.runHead);
      const now = yield* Clock.currentTimeMillis;
      const writes: string[] = [];
      let firstDecision: IntegrationWriteDecision | undefined;
      const running = yield* presenter
        .run((owner) =>
          Effect.gen(function* () {
            for (const id of ["first", "second"]) {
              const decision = yield* requestIntegrationWriteApproval(sampleReview(owner, id, now));
              if (id === "first") firstDecision = decision;
              if (!decision.approved || !decision.isCurrent()) return false;
              writes.push(id);
            }
            return true;
          }),
        )
        .pipe(Effect.forkScoped);
      const first = yield* nextReview(presenter);
      expect(first.review.payload).toContain("first final tail");
      expect(writes).toEqual([]);
      const response = {
        submissionId: first.submissionId,
        action: {
          type: "respond" as const,
          requestId: first.review.requestId,
          decision: "accept" as const,
        },
      };
      expect(Result.isFailure(yield* other.respond(response).pipe(Effect.result))).toBe(true);
      yield* presenter.respond(response);
      const second = yield* nextReview(presenter, first.review.requestId);
      expect(writes).toEqual(["first"]);
      expect(second.review.payload).toContain("second final tail");
      expect(Result.isFailure(yield* presenter.respond(response).pipe(Effect.result))).toBe(true);
      yield* presenter.respond({
        submissionId: second.submissionId,
        action: { type: "respond", requestId: second.review.requestId, decision: "accept" },
      });
      expect(yield* Fiber.join(running)).toBe(true);
      expect(writes).toEqual(["first", "second"]);
      expect(firstDecision?.approved && firstDecision.isCurrent()).toBe(false);
    }).pipe(Effect.scoped),
);

it.effect.each(["cancel", "close", "expire", "decline"] as const)(
  "settles a pending Settings write without committing on %s",
  (ending) =>
    Effect.gen(function* () {
      const presenter = yield* makeCommonsApproval({
        sessionId: AuthSessionId.make("synthetic-session"),
      });
      yield* presenter.changes.pipe(Stream.runHead);
      const now = yield* Clock.currentTimeMillis;
      let writes = 0;
      const running = yield* presenter
        .run((owner) =>
          requestIntegrationWriteApproval(sampleReview(owner, "pending", now)).pipe(
            Effect.flatMap((decision) =>
              decision.approved && decision.isCurrent()
                ? Effect.sync(() => {
                    writes += 1;
                  })
                : Effect.fail(
                    new ServerTritonAiCommonsError({
                      code: "cancelled",
                      message: "Synthetic refusal",
                    }),
                  ),
            ),
          ),
        )
        .pipe(Effect.forkScoped);
      const pending = yield* nextReview(presenter);
      if (ending === "cancel")
        yield* presenter.respond({
          submissionId: pending.submissionId,
          action: { type: "cancel" },
        });
      else if (ending === "close") yield* presenter.close();
      else if (ending === "expire") yield* TestClock.adjust("1001 millis");
      else
        yield* presenter.respond({
          submissionId: pending.submissionId,
          action: { type: "respond", requestId: pending.review.requestId, decision: "decline" },
        });
      const exit = yield* Fiber.await(running);
      expect(exit._tag).toBe("Failure");
      expect(writes).toBe(0);
      expect(
        Result.isFailure(
          yield* presenter
            .respond({
              submissionId: pending.submissionId,
              action: { type: "respond", requestId: pending.review.requestId, decision: "accept" },
            })
            .pipe(Effect.result),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped),
);

it.effect("can cancel preparation before there is a write to review", () =>
  Effect.gen(function* () {
    const presenter = yield* makeCommonsApproval({
      sessionId: AuthSessionId.make("synthetic-session"),
    });
    yield* presenter.changes.pipe(Stream.runHead);
    const running = yield* presenter.run(() => Effect.never).pipe(Effect.forkScoped);
    const pending = yield* presenter.changes.pipe(
      Stream.filter((value) => value !== null),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    expect(pending.review).toBeNull();
    yield* presenter.respond({ submissionId: pending.submissionId, action: { type: "cancel" } });
    expect((yield* Fiber.await(running))._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);
