import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

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
