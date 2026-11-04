// @effect-diagnostics nodeBuiltinImport:off -- Exercise the real local authorization protocol, including signatures and teardown.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { makeCodexBrowserAccessHost } from "./CodexBrowserAccessHost.ts";

import { requestBrowserAccess as call } from "./testFixtures/browserAccessClient.ts";

const params = (environment: Readonly<Record<string, string>>) => ({
  executorId: environment.BROWSER_USE_ACCESS_EXECUTOR_ID!,
  sessionId: "native-thread",
  turnId: "native-turn",
  nonce: "a".repeat(64),
});

describe("CodexBrowserAccessHost", () => {
  it.live("signs an exact live decision, rejects another executor, and honors revocation", () =>
    Effect.gen(function* () {
      const allowed = yield* Ref.make(true);
      const environment = yield* makeCodexBrowserAccessHost((request) =>
        Ref.get(allowed).pipe(
          Effect.map(
            (enabled) =>
              enabled && request.sessionId === "native-thread" && request.turnId === "native-turn",
          ),
        ),
      );
      const request = params(environment);
      const response = yield* call(environment, request);
      const key = NodeCrypto.createPublicKey({
        key: Buffer.from(environment.BROWSER_USE_ACCESS_VERIFYING_IDENTITY, "base64"),
        type: "spki",
        format: "der",
      });
      assert.isTrue(
        NodeCrypto.verify(
          null,
          Buffer.from(response.payload),
          key,
          Buffer.from(response.signature, "base64"),
        ),
      );
      assert.equal(
        response.payload,
        JSON.stringify({ domain: "codex.browserAccess.v1", request, allowed: true }),
      );
      for (const invalid of [
        { ...request, executorId: "other-executor" },
        { ...request, sessionId: "other-thread" },
        { ...request, turnId: "old-turn" },
      ]) {
        assert.isFalse(JSON.parse((yield* call(environment, invalid)).payload).allowed);
      }
      yield* Ref.set(allowed, false);
      assert.isFalse(
        JSON.parse((yield* call(environment, { ...request, nonce: "b".repeat(64) })).payload)
          .allowed,
      );
    }).pipe(Effect.scoped),
  );

  it.live("removes its private socket and directory when the provider closes", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const endpoint = yield* Effect.scoped(
        Effect.gen(function* () {
          const environment = yield* makeCodexBrowserAccessHost(() => Effect.succeed(false));
          const path = environment.BROWSER_USE_ACCESS_PIPE_PATH;
          if (platform !== "win32") {
            assert.equal((yield* Effect.promise(() => NodeFSP.stat(path))).mode & 0o777, 0o600);
            assert.equal(
              (yield* Effect.promise(() => NodeFSP.stat(NodePath.dirname(path)))).mode & 0o777,
              0o700,
            );
          }
          return path;
        }),
      );
      if (platform !== "win32") {
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(endpoint).then(
              () => true,
              () => false,
            ),
          ),
        );
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.dirname(endpoint)).then(
              () => true,
              () => false,
            ),
          ),
        );
      }
    }),
  );

  it.live("refuses malformed requests instead of signing them", () =>
    Effect.gen(function* () {
      const environment = yield* makeCodexBrowserAccessHost(() => Effect.succeed(true));
      const result = yield* call(environment, { ...params(environment), nonce: "invalid" }).pipe(
        Effect.result,
      );
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.scoped),
  );

  it.live("creates a fresh identity after restart and isolates concurrent providers", () =>
    Effect.gen(function* () {
      const first = yield* Effect.scoped(makeCodexBrowserAccessHost(() => Effect.succeed(true)));
      const restarted = yield* makeCodexBrowserAccessHost(() => Effect.succeed(true));
      const concurrent = yield* makeCodexBrowserAccessHost(() => Effect.succeed(true));
      assert.notEqual(first.BROWSER_USE_ACCESS_PIPE_PATH, restarted.BROWSER_USE_ACCESS_PIPE_PATH);
      assert.notEqual(
        first.BROWSER_USE_ACCESS_VERIFYING_IDENTITY,
        restarted.BROWSER_USE_ACCESS_VERIFYING_IDENTITY,
      );
      assert.equal((yield* call(first, params(first)).pipe(Effect.result))._tag, "Failure");
      assert.isTrue(JSON.parse((yield* call(restarted, params(restarted))).payload).allowed);
      assert.isTrue(JSON.parse((yield* call(concurrent, params(concurrent))).payload).allowed);
      for (const other of [first, concurrent]) {
        assert.isFalse(JSON.parse((yield* call(restarted, params(other))).payload).allowed);
      }
      assert.isFalse(JSON.parse((yield* call(concurrent, params(restarted))).payload).allowed);
    }).pipe(Effect.scoped),
  );

  it.live("interrupts an unfinished authorization when the provider closes", () =>
    Effect.gen(function* () {
      const pending = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const environment = yield* makeCodexBrowserAccessHost(() =>
        Deferred.succeed(pending, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      const request = yield* call(environment, params(environment)).pipe(
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(pending);
      yield* Scope.close(scope, Exit.void);
      assert.equal((yield* Fiber.join(request))._tag, "Failure");
    }).pipe(Effect.scoped),
  );
});
