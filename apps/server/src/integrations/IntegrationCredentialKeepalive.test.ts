import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

const { refreshIdleCredentials } = vi.hoisted(() => ({ refreshIdleCredentials: vi.fn() }));
vi.mock("./IntegrationRegistry.ts", () => ({
  getIntegrationRegistryOptional: () => ({ refreshIdleCredentials }),
}));

import {
  IntegrationCredentialKeepalive,
  IntegrationCredentialKeepaliveLive,
} from "./IntegrationCredentialKeepalive.ts";

it.effect("cancels the running credential sweep when its owning scope closes", () =>
  Effect.gen(function* () {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<ReadonlyArray<string>>((resolve) => {
      release = () => resolve([]);
    });
    let observedSignal: AbortSignal | undefined;
    refreshIdleCredentials.mockImplementation((options: { signal?: AbortSignal }) => {
      observedSignal = options.signal;
      markStarted();
      return pending;
    });
    const scope = yield* Scope.make();
    try {
      yield* Effect.gen(function* () {
        const service = yield* IntegrationCredentialKeepalive;
        yield* service.start();
      }).pipe(Effect.provide(IntegrationCredentialKeepaliveLive), Scope.provide(scope));
      yield* TestClock.adjust("15 minutes");
      yield* Effect.promise(() => started);
      yield* Scope.close(scope, Exit.void);
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      release();
      yield* Scope.close(scope, Exit.void);
    }
  }),
);

it.effect("records each credential sweep and its refreshes in the trace", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    let markSwept!: () => void;
    const swept = new Promise<void>((resolve) => {
      markSwept = resolve;
    });
    refreshIdleCredentials.mockImplementation(async () => {
      markSwept();
      return ["microsoft-365"];
    });
    const scope = yield* Scope.make();
    try {
      yield* Effect.gen(function* () {
        const service = yield* IntegrationCredentialKeepalive;
        yield* service.start();
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IntegrationCredentialKeepaliveLive, Logger.layer([Logger.tracerLogger])),
        ),
        Effect.withTracer(tracer),
        Scope.provide(scope),
      );
      yield* TestClock.adjust("15 minutes");
      yield* Effect.promise(() => swept);
      yield* Effect.yieldNow;
      const sweep = spans.find(({ name }) => name === "integrations.credential.keepalive.sweep");
      expect(
        sweep?.events.some(([name]) =>
          name.includes("integrations.credential.keepalive.refreshed"),
        ),
      ).toBe(true);
    } finally {
      yield* Scope.close(scope, Exit.void);
    }
  }),
);
