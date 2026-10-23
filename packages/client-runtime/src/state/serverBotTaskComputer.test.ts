import {
  EnvironmentId,
  WS_METHODS,
  type ServerBotTaskComputerStatus,
  type ServerConfig,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const OFF: ServerBotTaskComputerStatus = {
  state: "off",
  deviceId: "synthetic-harness",
  deviceName: "Synthetic Harness",
  apiUrl: null,
  userId: null,
  projectId: null,
  currentTask: null,
  lastCheckInAt: null,
  message: null,
};
const ACTIVE: ServerBotTaskComputerStatus = {
  ...OFF,
  state: "idle",
  apiUrl: "https://bot.example.test",
  userId: "synthetic-owner",
};

const makeHarness = Effect.fn("BotStatusTest.makeHarness")(function* (
  initial: ServerBotTaskComputerStatus,
) {
  let status = initial;
  const read = vi.fn(() => Effect.sync(() => status));
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("bot-status-environment"),
    label: "Synthetic Harness",
    httpBaseUrl: "https://harness.example.test",
    wsBaseUrl: "wss://harness.example.test",
  });
  const client = { [WS_METHODS.serverGetBotTaskComputer]: read } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({} as ServerConfig),
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
      Layer.succeed(
        Persistence.EnvironmentCacheStore,
        Persistence.EnvironmentCacheStore.of({
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
        }),
      ),
    ),
  );
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => Atom.make(null),
  });
  const atom = atoms.botTaskComputer({ environmentId: target.environmentId, input: {} });
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  return {
    read,
    setStatus(next: ServerBotTaskComputerStatus) {
      status = next;
    },
    refresh() {
      registry.refresh(atom);
    },
    settled: () => AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
    [Symbol.dispose]() {
      unmount();
      registry.dispose();
    },
  };
});

function timers() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return {
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}

it.effect("reads off status on mount and explicit discovery without periodic polling", () =>
  Effect.gen(function* () {
    using _timers = timers();
    using harness = yield* makeHarness(OFF);
    expect(yield* harness.settled()).toEqual(OFF);
    expect(harness.read).toHaveBeenCalledOnce();
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
    expect(harness.read).toHaveBeenCalledOnce();
    harness.setStatus(ACTIVE);
    harness.refresh();
    expect(yield* harness.settled()).toEqual(ACTIVE);
    expect(harness.read).toHaveBeenCalledTimes(2);
  }),
);

it.effect.each(["idle", "running", "error", "replaced"] as const)(
  "polls a %s pairing every 15 seconds, stops when off, and resumes after discovery",
  (state) =>
    Effect.gen(function* () {
      using _timers = timers();
      const initial = { ...ACTIVE, state };
      using harness = yield* makeHarness(initial);
      expect(yield* harness.settled()).toEqual(initial);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(14_999));
      expect(harness.read).toHaveBeenCalledOnce();
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
      expect(yield* harness.settled()).toEqual(initial);
      expect(harness.read).toHaveBeenCalledTimes(2);
      harness.setStatus(OFF);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(15_000));
      expect(yield* harness.settled()).toEqual(OFF);
      expect(harness.read).toHaveBeenCalledTimes(3);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
      expect(harness.read).toHaveBeenCalledTimes(3);
      harness.setStatus(ACTIVE);
      harness.refresh();
      expect(yield* harness.settled()).toEqual(ACTIVE);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(15_000));
      expect(yield* harness.settled()).toEqual(ACTIVE);
      expect(harness.read).toHaveBeenCalledTimes(5);
    }),
);
