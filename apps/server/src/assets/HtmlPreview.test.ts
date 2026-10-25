// @effect-diagnostics nodeBuiltinImport:off - verifies termination of the owned parser PID.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HtmlPreview from "./HtmlPreview.ts";
import * as HtmlPreviewTestkit from "./HtmlPreview.testkit.ts";

it.effect("sanitizes UTF-8 through the bounded server worker", () =>
  Effect.gen(function* () {
    const preview = yield* HtmlPreview.HtmlPreview;
    const result = yield* preview.render(
      '<p>Résumé ☃</p><script>throw new Error("author script")</script>',
    );
    expect(result.html).toContain("Résumé ☃");
    expect(result.html).not.toContain("author script");
    expect(result.headers["Content-Security-Policy"]).toContain("connect-src 'none'");
    expect(result.headers["Referrer-Policy"]).toBe("no-referrer");
  }).pipe(Effect.provide(HtmlPreviewTestkit.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect("kills a synchronous parser when the request is cancelled", () =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const started = yield* Deferred.make<number>();
    const observedSpawner = ChildProcessSpawner.ChildProcessSpawner.of({
      ...spawner,
      spawn: (command) =>
        spawner.spawn(command).pipe(
          Effect.map((child) => ({
            ...child,
            stdout: child.stdout.pipe(
              Stream.tap(() => Deferred.succeed(started, Number(child.pid))),
            ),
          })),
        ),
    });
    const testLayer = HtmlPreview.layerWithCommand({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("ready"); while (true) {}'],
    }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, observedSpawner)));
    yield* Effect.gen(function* () {
      const preview = yield* HtmlPreview.HtmlPreview;
      const request = yield* preview.render("<p>Synthetic</p>").pipe(Effect.forkScoped);
      const pid = yield* Deferred.await(started);
      // This continuation runs while the child remains in its synchronous loop.
      expect(() => process.kill(pid, 0)).not.toThrow();
      yield* Fiber.interrupt(request);
      expect(() => process.kill(pid, 0)).toThrow();
    }).pipe(Effect.provide(testLayer), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses HTML when the runtime cannot resolve a worker", () =>
  Effect.gen(function* () {
    const preview = yield* HtmlPreview.HtmlPreview;
    const error = yield* preview.render("<p>Synthetic</p>").pipe(Effect.flip);
    expect(error.reason).toBe("Preview worker unavailable");
  }).pipe(
    Effect.provide(HtmlPreview.layerWithCommand(null).pipe(Layer.provide(NodeServices.layer))),
  ),
);
