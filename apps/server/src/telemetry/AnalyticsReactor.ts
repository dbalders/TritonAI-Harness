import type { OrchestrationEvent, ProviderRuntimeEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { AnalyticsService } from "./AnalyticsService.ts";

type TrackedDomainEvent = Extract<OrchestrationEvent, { type: "thread.created" }>;
type TrackedProviderEvent = Extract<ProviderRuntimeEvent, { type: "turn.completed" }>;

type AnalyticsInput =
  | { readonly source: "domain"; readonly event: TrackedDomainEvent }
  | { readonly source: "provider"; readonly event: TrackedProviderEvent };

export class AnalyticsReactor extends Context.Service<
  AnalyticsReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsReactor") {}

export const makeAnalyticsReactor = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const processInput = Effect.fn("AnalyticsReactor.processInput")(function* (
    input: AnalyticsInput,
  ) {
    if (input.source === "domain") {
      yield* analytics.record("thread.created", {
        runtimeMode: input.event.payload.runtimeMode,
        interactionMode: input.event.payload.interactionMode,
      });
      return;
    }

    yield* analytics.record("provider.turn.completed", {
      provider: input.event.provider,
      outcome: input.event.payload.state,
    });
  });

  const worker = yield* makeDrainableWorker(processInput);

  const start: AnalyticsReactor["Service"]["start"] = Effect.fn("AnalyticsReactor.start")(
    function* () {
      yield* Effect.addFinalizer(() => worker.drain.pipe(Effect.andThen(analytics.flush)));
      yield* Effect.forkScoped(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type !== "thread.created") return Effect.void;
          return worker.enqueue({ source: "domain", event });
        }),
        { startImmediately: true },
      );
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) => {
          if (event.type !== "turn.completed") return Effect.void;
          return worker.enqueue({ source: "provider", event });
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
