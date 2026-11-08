import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as HelpIntegrations from "./HelpIntegrations.ts";

it.effect(
  "reads the supplied cached snapshot afresh, with no registry acquisition or refresh",
  () => {
    let reads = 0;
    return Effect.gen(function* () {
      const source = yield* HelpIntegrations.HelpIntegrations;
      assert.deepEqual(yield* source.snapshot, { integrations: [] });
      assert.isUndefined(yield* source.snapshot);
      assert.equal(reads, 2);
    }).pipe(
      Effect.provide(
        HelpIntegrations.layerFromSnapshot(async () =>
          ++reads === 1 ? { integrations: [] } : undefined,
        ),
      ),
    );
  },
);

it.effect("turns snapshot failure into unavailable evidence without exposing its cause", () =>
  Effect.gen(function* () {
    assert.isUndefined(yield* (yield* HelpIntegrations.HelpIntegrations).snapshot);
  }).pipe(
    Effect.provide(
      HelpIntegrations.layerFromSnapshot(() =>
        Promise.reject(new Error("private registry failure")),
      ),
    ),
  ),
);

it.effect("bounds a stalled cached snapshot without hanging Help", () =>
  Effect.gen(function* () {
    const source = yield* HelpIntegrations.HelpIntegrations;
    const pending = yield* source.snapshot.pipe(Effect.forkChild);
    yield* TestClock.adjust("3 seconds");
    assert.isUndefined(yield* Fiber.join(pending));
  }).pipe(Effect.provide(HelpIntegrations.layerFromSnapshot(() => new Promise(() => {})))),
);
