import { it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as AnalyticsReactor from "./AnalyticsReactor.ts";
import { AnalyticsService } from "./AnalyticsService.ts";

// regression: e4f5214b2d count each turn once and send client usage events to Plausible
it.effect("records canonical thread creation without identifiers", () =>
  Effect.gen(function* () {
    const recorded: Array<{
      readonly event: string;
      readonly properties: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    let flushCount = 0;
    const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();

    const layer = Layer.effect(
      AnalyticsReactor.AnalyticsReactor,
      AnalyticsReactor.makeAnalyticsReactor(Stream.fromPubSub(domainEvents)),
    ).pipe(
      Layer.provideMerge(
        Layer.succeed(
          AnalyticsService,
          AnalyticsService.of({
            record: (event, properties) =>
              Effect.sync(() => {
                recorded.push({ event, properties });
              }),
            flush: Effect.sync(() => {
              flushCount += 1;
            }),
          }),
        ),
      ),
    );
    const scope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const services = yield* Layer.build(layer).pipe(Scope.provide(scope));

    yield* Effect.gen(function* () {
      const reactor = yield* AnalyticsReactor.AnalyticsReactor;
      yield* reactor.start().pipe(Scope.provide(scope));

      const now = DateTime.makeUnsafe("2026-07-17T00:00:00.000Z");
      const threadId = ThreadId.make("thread-1");
      yield* PubSub.publish(domainEvents, {
        type: "thread.created",
        id: EventId.make("event-thread-created"),
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          createdBy: "user",
          creationSource: "web",
          projectId: ProjectId.make("project-1"),
          title: "Private title that must not be recorded",
          providerInstanceId: ProviderInstanceId.make("private-provider-instance"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("private-provider-instance"),
            model: "private-model-name",
          },
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: "private-branch",
          worktreePath: "/private/worktree",
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* Effect.yieldNow;
      yield* reactor.drain;

      expect(recorded).toEqual([
        {
          event: "thread.created",
          properties: {
            runtimeMode: "full-access",
            interactionMode: "plan",
          },
        },
      ]);

      yield* Scope.close(scope, Exit.void);
      expect(flushCount).toBe(1);
    }).pipe(Effect.provide(services));
  }),
);
