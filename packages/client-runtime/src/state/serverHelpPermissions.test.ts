import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type HelpAskInput,
  type HelpContext,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import { requestGuarded } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));

const sessions = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const ENVIRONMENT = EnvironmentId.make("help-environment");
const OTHER_ENVIRONMENT = EnvironmentId.make("other-environment");
const ALL_SCOPES = [
  AuthOrchestrationOperateScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
];
const INPUT: HelpAskInput = {
  messages: [{ role: "user", content: "Where can I configure my provider?" }],
};
const CONTEXT: HelpContext = {
  capturedAt: "2026-10-22T12:00:00Z",
  environmentId: ENVIRONMENT,
  environmentName: "Help environment",
  version: "test",
  platform: "test",
  mode: "test",
  paths: [],
  providers: [],
  modelLabel: "Test model",
  diagnostics: {
    recordCount: 0,
    failureCount: 0,
    slowSpanCount: 0,
    partial: false,
    recentFailures: [],
  },
};

const grant = (
  scopes: readonly AuthEnvironmentScope[],
  permissions = scopes,
): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes,
  permissions,
});

const makeHarness = Effect.fn("HelpPermissionsTest.makeHarness")(function* (
  routedEnvironment?: EnvironmentId,
) {
  const calls: Array<{ environmentId: EnvironmentId; method: string; input: unknown }> = [];
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  for (const environmentId of [ENVIRONMENT, OTHER_ENVIRONMENT]) {
    const client = {
      [WS_METHODS.helpGetContext]: (input: unknown) =>
        Effect.sync(() => {
          calls.push({ environmentId, method: WS_METHODS.helpGetContext, input });
          return { ...CONTEXT, environmentId };
        }),
      [WS_METHODS.helpAsk]: (input: HelpAskInput) =>
        Effect.sync(() => {
          calls.push({ environmentId, method: WS_METHODS.helpAsk, input });
          return { answer: "Open Settings > Providers.", context: { ...CONTEXT, environmentId } };
        }),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.succeed({} as ServerConfig),
      subscribeServerConfig: (input) => client.subscribeServerConfig(input),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    supervisors.set(
      environmentId,
      EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://environment.example.test",
          wsBaseUrl: "wss://environment.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
  }
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (environmentId, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisors.get(routedEnvironment ?? environmentId)!,
      ),
    followStream: (environmentId, stream) =>
      Stream.provideService(
        stream,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisors.get(routedEnvironment ?? environmentId)!,
      ),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
      Layer.succeed(Persistence.EnvironmentCacheStore, cache),
    ),
  );
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => Atom.make<ServerConfig | null>(null),
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const setGrant = (environmentId: EnvironmentId, session: AuthSessionState) =>
    registry.set(sessions(environmentId), AsyncResult.success(session));
  return { atoms, calls, registry, setGrant, environments };
});

describe("Help permissions", () => {
  it.effect(
    "reads Help context with read and diagnostics grants while invocation stays unavailable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { atoms, calls, registry, setGrant } = yield* makeHarness();
          setGrant(ENVIRONMENT, grant([AuthDiagnosticsReadScope, AuthOrchestrationReadScope]));
          const atom = atoms.helpContext({ environmentId: ENVIRONMENT, input: {} });
          yield* AtomRegistry.mount(registry, atom);
          expect(yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true })).toEqual(
            CONTEXT,
          );
          expect(registry.get(atoms.askHelp.permissionAtom(ENVIRONMENT))).toBe(false);
          expect(calls).toEqual([
            { environmentId: ENVIRONMENT, method: WS_METHODS.helpGetContext, input: {} },
          ]);
        }),
      ),
  );

  it.effect.each([
    { scopes: [], missing: AuthDiagnosticsReadScope },
    { scopes: [AuthOrchestrationOperateScope], missing: AuthDiagnosticsReadScope },
    { scopes: [AuthDiagnosticsReadScope], missing: AuthOrchestrationReadScope },
  ])("blocks Help context transport without $missing ($scopes)", ({ scopes, missing }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, calls, registry, setGrant } = yield* makeHarness();
        setGrant(ENVIRONMENT, grant(scopes));
        const atom = atoms.helpContext({ environmentId: ENVIRONMENT, input: {} });
        yield* AtomRegistry.mount(registry, atom);
        const denied = yield* AtomRegistry.getResult(registry, atom, {
          suspendOnWaiting: true,
        }).pipe(Effect.flip);
        expect(denied).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: missing,
        });
        expect(calls).toEqual([]);
      }),
    ),
  );

  it.effect("rechecks context permission on refresh and recovers after the grant returns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, calls, registry, setGrant } = yield* makeHarness();
        setGrant(ENVIRONMENT, grant([AuthDiagnosticsReadScope, AuthOrchestrationReadScope]));
        const atom = atoms.helpContext({ environmentId: ENVIRONMENT, input: {} });
        yield* AtomRegistry.mount(registry, atom);
        yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        setGrant(ENVIRONMENT, grant(ALL_SCOPES, []));
        registry.refresh(atom);
        const denied = yield* AtomRegistry.getResult(registry, atom, {
          suspendOnWaiting: true,
        }).pipe(Effect.flip);
        expect(denied).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthDiagnosticsReadScope,
        });
        expect(calls).toHaveLength(1);
        setGrant(ENVIRONMENT, grant([AuthDiagnosticsReadScope, AuthOrchestrationReadScope]));
        registry.refresh(atom);
        expect(yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true })).toEqual(
          CONTEXT,
        );
        expect(calls).toHaveLength(2);
      }),
    ),
  );

  it.effect("uses the actual destination grant for a routed Help context query", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, calls, registry, setGrant } = yield* makeHarness(OTHER_ENVIRONMENT);
        setGrant(ENVIRONMENT, grant(ALL_SCOPES));
        setGrant(OTHER_ENVIRONMENT, grant([AuthOrchestrationOperateScope]));
        const atom = atoms.helpContext({ environmentId: ENVIRONMENT, input: {} });
        yield* AtomRegistry.mount(registry, atom);
        const denied = yield* AtomRegistry.getResult(registry, atom, {
          suspendOnWaiting: true,
        }).pipe(Effect.flip);
        expect(denied).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthDiagnosticsReadScope,
        });
        expect(calls).toEqual([]);
        setGrant(OTHER_ENVIRONMENT, grant([AuthDiagnosticsReadScope, AuthOrchestrationReadScope]));
        registry.refresh(atom);
        expect(yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true })).toEqual({
          ...CONTEXT,
          environmentId: OTHER_ENVIRONMENT,
        });
        expect(calls).toEqual([
          { environmentId: OTHER_ENVIRONMENT, method: WS_METHODS.helpGetContext, input: {} },
        ]);
      }),
    ),
  );

  it.effect("blocks transport dispatch when a required permission is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, calls, registry, setGrant } = yield* makeHarness();
        for (const [scopes, missing] of [
          [[], AuthOrchestrationOperateScope],
          [[AuthDiagnosticsReadScope], AuthOrchestrationOperateScope],
          [[AuthOrchestrationOperateScope], AuthDiagnosticsReadScope],
          [[AuthOrchestrationOperateScope, AuthDiagnosticsReadScope], AuthOrchestrationReadScope],
        ] as const) {
          setGrant(ENVIRONMENT, grant(scopes));
          expect(registry.get(atoms.askHelp.permissionAtom(ENVIRONMENT))).toBe(false);
          const result = yield* Effect.promise(() =>
            atoms.askHelp.run(registry, { environmentId: ENVIRONMENT, input: INPUT }),
          );
          expect(result._tag).toBe("Failure");
          if (AsyncResult.isFailure(result)) {
            expect(Option.getOrThrow(AsyncResult.error(result))).toMatchObject({
              _tag: "EnvironmentAuthorizationError",
              requiredPermission: missing,
            });
          }
        }
        expect(calls).toEqual([]);
        setGrant(ENVIRONMENT, grant(ALL_SCOPES));
        expect(registry.get(atoms.askHelp.permissionAtom(ENVIRONMENT))).toBe(true);
        const allowed = yield* Effect.promise(() =>
          atoms.askHelp.run(registry, { environmentId: ENVIRONMENT, input: INPUT }),
        );
        expect(allowed).toMatchObject({ _tag: "Success", value: { context: CONTEXT } });
        expect(calls).toEqual([
          { environmentId: ENVIRONMENT, method: WS_METHODS.helpAsk, input: INPUT },
        ]);
      }),
    ),
  );

  it.effect("uses each destination's exact grants and rechecks after UI availability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, calls, registry, setGrant } = yield* makeHarness();
        setGrant(ENVIRONMENT, grant(ALL_SCOPES));
        setGrant(OTHER_ENVIRONMENT, grant(ALL_SCOPES, [AuthDiagnosticsReadScope]));
        expect(registry.get(atoms.askHelp.permissionAtom(ENVIRONMENT))).toBe(true);
        expect(registry.get(atoms.askHelp.permissionAtom(OTHER_ENVIRONMENT))).toBe(false);
        expect(registry.get(atoms.askHelp.permissionAtom(null))).toBe(false);
        const other = yield* Effect.promise(() =>
          atoms.askHelp.run(registry, { environmentId: OTHER_ENVIRONMENT, input: INPUT }),
        );
        expect(other._tag).toBe("Failure");
        setGrant(ENVIRONMENT, grant(ALL_SCOPES, []));
        const revoked = yield* Effect.promise(() =>
          atoms.askHelp.run(registry, { environmentId: ENVIRONMENT, input: INPUT }),
        );
        expect(revoked._tag).toBe("Failure");
        expect(calls).toEqual([]);
        setGrant(OTHER_ENVIRONMENT, grant(ALL_SCOPES));
        const allowed = yield* Effect.promise(() =>
          atoms.askHelp.run(registry, { environmentId: OTHER_ENVIRONMENT, input: INPUT }),
        );
        expect(allowed).toMatchObject({
          _tag: "Success",
          value: { context: { environmentId: OTHER_ENVIRONMENT } },
        });
        expect(calls).toEqual([
          { environmentId: OTHER_ENVIRONMENT, method: WS_METHODS.helpAsk, input: INPUT },
        ]);
      }),
    ),
  );

  it.effect("rejects both protected Help methods outside their permission boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, environments, setGrant } = yield* makeHarness();
        setGrant(ENVIRONMENT, grant(ALL_SCOPES));
        const context = yield* environments
          .run(ENVIRONMENT, requestGuarded(WS_METHODS.helpGetContext, {}))
          .pipe(Effect.flip);
        const ask = yield* environments
          .run(ENVIRONMENT, requestGuarded(WS_METHODS.helpAsk, INPUT))
          .pipe(Effect.flip);
        expect(context).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthDiagnosticsReadScope,
        });
        expect(ask).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthOrchestrationOperateScope,
        });
        expect(calls).toEqual([]);
      }),
    ),
  );

  it.effect(
    "rechecks the actual transport destination when an environment routes the request",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { atoms, calls, registry, setGrant } = yield* makeHarness(OTHER_ENVIRONMENT);
          setGrant(ENVIRONMENT, grant(ALL_SCOPES));
          setGrant(
            OTHER_ENVIRONMENT,
            grant([AuthDiagnosticsReadScope, AuthOrchestrationReadScope]),
          );
          expect(registry.get(atoms.askHelp.permissionAtom(ENVIRONMENT))).toBe(true);
          const denied = yield* Effect.promise(() =>
            atoms.askHelp.run(registry, { environmentId: ENVIRONMENT, input: INPUT }),
          );
          expect(denied._tag).toBe("Failure");
          if (AsyncResult.isFailure(denied)) {
            expect(Option.getOrThrow(AsyncResult.error(denied))).toMatchObject({
              _tag: "EnvironmentAuthorizationError",
              requiredPermission: AuthOrchestrationOperateScope,
            });
          }
          expect(calls).toEqual([]);
          setGrant(OTHER_ENVIRONMENT, grant(ALL_SCOPES));
          const allowed = yield* Effect.promise(() =>
            atoms.askHelp.run(registry, { environmentId: ENVIRONMENT, input: INPUT }),
          );
          expect(allowed).toMatchObject({
            _tag: "Success",
            value: { context: { environmentId: OTHER_ENVIRONMENT } },
          });
          expect(calls).toEqual([
            { environmentId: OTHER_ENVIRONMENT, method: WS_METHODS.helpAsk, input: INPUT },
          ]);
        }),
      ),
  );
});
