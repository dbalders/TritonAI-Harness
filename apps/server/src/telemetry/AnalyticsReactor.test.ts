import { it } from "@effect/vitest";
import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as AnalyticsReactor from "./AnalyticsReactor.ts";
import { AnalyticsService } from "./AnalyticsService.ts";

it.effect("records canonical thread creation without identifiers", () =>
  Effect.gen(function* () {
    const recorded: Array<{
      readonly event: string;
      readonly properties: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    let flushCount = 0;
    const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();

    const layer = AnalyticsReactor.layer.pipe(
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
      Layer.provideMerge(
        Layer.succeed(
          OrchestrationEngineService,
          OrchestrationEngineService.of({
            readEvents: () => Stream.empty,
            readThreadEvents: () => Stream.empty,
            getThreadReplayStats: () =>
              Effect.succeed({ eventCount: 0, payloadBytes: 0, hasCreateEvent: false }),
            subscribeDomainEvents: PubSub.subscribe(domainEvents).pipe(
              Effect.map(Stream.fromSubscription),
            ),
            dispatch: () => Effect.die("dispatch is not used by this test"),
            latestSequence: Effect.succeed(0),
            streamDomainEvents: Stream.fromPubSub(domainEvents),
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

      yield* PubSub.publish(domainEvents, {
        type: "thread.created",
        eventId: EventId.make("event-thread-created"),
        commandId: CommandId.make("command-thread-created"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        sequence: 1,
        occurredAt: "2026-07-17T00:00:00.000Z",
        causationEventId: null,
        correlationId: CorrelationId.make("command-thread-created"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Private title that must not be recorded",
          modelSelection: {
            instanceId: ProviderInstanceId.make("private-provider-instance"),
            model: "private-model-name",
          },
          runtimeMode: "full-access",
          interactionMode: "plan",
          branch: "private-branch",
          worktreePath: "/private/worktree",
          createdAt: "2026-07-17T00:00:00.000Z",
          updatedAt: "2026-07-17T00:00:00.000Z",
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
