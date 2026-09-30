import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { AnalyticsService } from "./AnalyticsService.ts";

type TrackedDomainEvent = Extract<OrchestrationEvent, { type: "thread.created" }>;

// Turn completion is recorded by ProviderService, which deduplicates completions
// and attaches duration and token usage. Recording it here too double-counted turns.
export class AnalyticsReactor extends Context.Service<
  AnalyticsReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsReactor") {}

const makeAnalyticsReactor = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const processEvent = Effect.fn("AnalyticsReactor.processEvent")(function* (
    event: TrackedDomainEvent,
  ) {
    yield* analytics.record("thread.created", {
      runtimeMode: event.payload.runtimeMode,
      interactionMode: event.payload.interactionMode,
    });
  });

  const worker = yield* makeDrainableWorker(processEvent);

  const start: AnalyticsReactor["Service"]["start"] = Effect.fn("AnalyticsReactor.start")(
    function* () {
      yield* Effect.addFinalizer(() => worker.drain.pipe(Effect.andThen(analytics.flush)));
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.created") return Effect.void;
          return worker.enqueue(event);
        }),
        { startImmediately: true },
      );
    },
  );

  return AnalyticsReactor.of({
    start,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(AnalyticsReactor, makeAnalyticsReactor);
