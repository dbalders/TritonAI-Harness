import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import * as HelpIntegrations from "./HelpIntegrations.ts";

it.effect("bounds a stalled cached snapshot without hanging Help", () =>
  Effect.gen(function* () {
    const source = yield* HelpIntegrations.HelpIntegrations;
    const pending = yield* source.snapshot.pipe(Effect.forkChild);
    yield* TestClock.adjust("3 seconds");
    assert.isUndefined(yield* Fiber.join(pending));
  }).pipe(Effect.provide(HelpIntegrations.layerFromSnapshot(() => new Promise(() => {})))),
);
