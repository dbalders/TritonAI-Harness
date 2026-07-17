import { it } from "@effect/vitest";
import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../provider/Services/ProviderService.ts";
import * as AnalyticsReactor from "./AnalyticsReactor.ts";
import { AnalyticsService } from "./AnalyticsService.ts";

it.effect("records canonical thread creation and turn completion without identifiers", () =>
  Effect.gen(function* () {
    const recorded: Array<{
      readonly event: string;
      readonly properties: Readonly<Record<string, unknown>> | undefined;
    }> = [];
    let flushCount = 0;
    const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const providerEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();

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
            dispatch: () => Effect.die("dispatch is not used by this test"),
            streamDomainEvents: Stream.fromPubSub(domainEvents),
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderService, {
          streamEvents: Stream.fromPubSub(providerEvents),
        } as ProviderServiceShape),
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
      yield* PubSub.publish(providerEvents, {
        type: "turn.completed",
        eventId: EventId.make("event-turn-completed"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("private-provider-instance"),
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-07-17T00:01:00.000Z",
        payload: {
          state: "completed",
          usage: { private: "usage" },
          modelUsage: { private: "model-usage" },
          totalCostUsd: 1.23,
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
        {
          event: "provider.turn.completed",
          properties: {
            provider: "codex",
            outcome: "completed",
          },
        },
      ]);

      yield* Scope.close(scope, Exit.void);
      expect(flushCount).toBe(1);
    }).pipe(Effect.provide(services));
  }),
);
