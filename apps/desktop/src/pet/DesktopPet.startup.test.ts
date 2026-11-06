import { it } from "@effect/vitest";
import { beforeEach, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { PET_ACTION_CHANNEL } from "../ipc/channels.ts";
import { DesktopPet, layer } from "./DesktopPet.ts";

const state = vi.hoisted(() => ({
  ready: false,
  readyListener: () => {},
  reads: 0,
  on: vi.fn(),
  remove: vi.fn(),
  removeReady: vi.fn(),
  getAllDisplays: vi.fn(),
  getPrimaryDisplay: vi.fn(),
  getDisplayMatching: vi.fn(),
  fromId: vi.fn(),
  fromWebContents: vi.fn(),
  petWindow: {
    show: vi.fn(),
    hide: vi.fn(),
    update: vi.fn(),
    destroy: vi.fn(),
  },
  onAction: (() => {}) as (action: unknown) => void,
}));
vi.mock("electron", () => ({
  webContents: { fromId: state.fromId },
  BrowserWindow: { fromWebContents: state.fromWebContents },
  app: {
    isReady: () => state.ready,
    once: (_name: string, fn: () => void) => {
      state.readyListener = fn;
    },
    removeListener: state.removeReady,
  },
  get screen() {
    state.reads++;
    if (!state.ready) throw new Error("screen accessed before ready");
    return {
      on: state.on,
      removeListener: state.remove,
      getAllDisplays: state.getAllDisplays,
      getPrimaryDisplay: state.getPrimaryDisplay,
      getDisplayMatching: state.getDisplayMatching,
    };
  },
}));
vi.mock("./PetWindow.ts", () => ({
  makePetWindow: (_platform: string, _preloadPath: string, onAction: (action: unknown) => void) => {
    state.onAction = onAction;
    return state.petWindow;
  },
}));
const runtime = layer.pipe(
  Layer.provide(
    Layer.succeed(DesktopEnvironment, {
      path: { join: (...parts: string[]) => parts.join("/") },
      dirname: "/probe",
      platform: "win32",
    } as never),
  ),
);
beforeEach(() => {
  vi.clearAllMocks();
  state.ready = false;
  state.reads = 0;
  state.readyListener = () => {};
});

function setupTwoOwners() {
  const ownerBounds = { x: 2560, y: 100, width: 1920, height: 1080 };
  const send7 = vi.fn();
  const send8 = vi.fn();
  const contents7 = {
    id: 7,
    isDestroyed: () => false,
    getBounds: () => ownerBounds,
    send: send7,
    once: vi.fn(),
  };
  const contents8 = {
    id: 8,
    isDestroyed: () => false,
    getBounds: () => ownerBounds,
    send: send8,
    once: vi.fn(),
  };
  state.fromId.mockImplementation((id: number) => (id === 7 ? contents7 : contents8));
  const ownerWindow = {
    isDestroyed: () => false,
    getBounds: () => ownerBounds,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
  state.fromWebContents.mockReturnValue(ownerWindow);
  state.getAllDisplays.mockReturnValue([{ id: 3, workArea: ownerBounds }]);
  state.getDisplayMatching.mockReturnValue({ workArea: ownerBounds });
  return { send7, send8, ownerWindow };
}

it.effect("builds before ready without touching screen, then registers and cleans up", () =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(runtime);
        expect(state.reads).toBe(0);
        expect(state.on).not.toHaveBeenCalled();
        state.ready = true;
        state.readyListener();
        expect(state.on.mock.calls.map(([name]) => name)).toEqual([
          "display-metrics-changed",
          "display-removed",
          "display-added",
        ]);
      }),
    );
    expect(state.remove).toHaveBeenCalledTimes(3);
    expect(state.removeReady).toHaveBeenCalledOnce();
    expect(state.petWindow.destroy).toHaveBeenCalledOnce();
  }),
);

it.effect("can dispose before ready without accessing screen", () =>
  Effect.gen(function* () {
    yield* Effect.scoped(Layer.build(runtime));
    expect(state.reads).toBe(0);
    expect(state.removeReady).toHaveBeenCalledOnce();
    expect(state.petWindow.destroy).toHaveBeenCalledOnce();
  }),
);

it.effect("registers immediately when Electron is already ready", () =>
  Effect.gen(function* () {
    state.ready = true;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(runtime);
        expect(state.on).toHaveBeenCalledTimes(3);
      }),
    );
    expect(state.remove).toHaveBeenCalledTimes(3);
  }),
);

it.effect("hides on close without notifying the renderer", () =>
  Effect.gen(function* () {
    state.ready = true;
    const send = vi.fn();
    const ownerBounds = { x: 2560, y: 100, width: 1920, height: 1080 };
    state.fromId.mockReturnValue({
      id: 7,
      isDestroyed: () => false,
      getBounds: () => ownerBounds,
      send,
      once: vi.fn(),
    });
    state.fromWebContents.mockReturnValue({
      isDestroyed: () => false,
      getBounds: () => ownerBounds,
    });
    state.getAllDisplays.mockReturnValue([
      { id: 1, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
      { id: 2, workArea: { x: 0, y: 0, width: 2560, height: 1440 } },
      { id: 3, workArea: ownerBounds },
    ]);
    state.getDisplayMatching.mockReturnValue({ workArea: ownerBounds });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(runtime);
        const pet = Context.get(context, DesktopPet);
        yield* pet.open(7);
        yield* pet.close();
      }),
    );
    expect(state.petWindow.show).toHaveBeenCalledWith(
      [
        { id: 1, area: { x: -1920, y: 0, width: 1920, height: 1080 } },
        { id: 2, area: { x: 0, y: 0, width: 2560, height: 1440 } },
        { id: 3, area: ownerBounds },
      ],
      { x: 4396, y: 1096 },
    );
    expect(state.petWindow.hide).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  }),
);

it.effect("ignores close from a non-owner renderer", () =>
  Effect.gen(function* () {
    state.ready = true;
    setupTwoOwners();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(runtime);
        const pet = Context.get(context, DesktopPet);
        yield* pet.open(7);
        yield* pet.open(8);
        yield* pet.close(7);
        expect(state.petWindow.hide).not.toHaveBeenCalled();
        yield* pet.close(8);
      }),
    );
    expect(state.petWindow.hide).toHaveBeenCalledOnce();
  }),
);

it.effect("hands the pet to another owner when the current owner closes", () =>
  Effect.gen(function* () {
    state.ready = true;
    setupTwoOwners();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(runtime);
        const pet = Context.get(context, DesktopPet);
        yield* pet.open(7);
        yield* pet.open(8);
        yield* pet.close(8);
        expect(state.petWindow.hide).not.toHaveBeenCalled();
        yield* pet.close(7);
      }),
    );
    expect(state.petWindow.hide).toHaveBeenCalledOnce();
  }),
);

it.effect("keeps a non-current owner's state off the shared pet", () =>
  Effect.gen(function* () {
    state.ready = true;
    setupTwoOwners();
    const owner7State = { pet: "trident", movement: "static", threads: [] } as const;
    const owner8State = { pet: "triton", movement: "static", threads: [] } as const;
    const staleOwner7State = { pet: "raccoon", movement: "static", threads: [] } as const;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(runtime);
        const pet = Context.get(context, DesktopPet);
        yield* pet.open(7);
        yield* pet.open(8);
        yield* pet.setState(7, owner7State);
        yield* pet.setState(8, owner8State);
        yield* pet.setState(7, staleOwner7State);
      }),
    );
    expect(state.petWindow.update).toHaveBeenCalledTimes(1);
    expect(state.petWindow.update).toHaveBeenLastCalledWith(owner8State);
  }),
);

it.effect("restores the fallback owner's cached state", () =>
  Effect.gen(function* () {
    state.ready = true;
    setupTwoOwners();
    const owner7State = { pet: "trident", movement: "static", threads: [] } as const;
    const owner8State = { pet: "triton", movement: "static", threads: [] } as const;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(runtime);
        const pet = Context.get(context, DesktopPet);
        yield* pet.open(7);
        yield* pet.open(8);
        yield* pet.setState(7, owner7State);
        yield* pet.setState(8, owner8State);
        yield* pet.close(8);
      }),
    );
    expect(state.petWindow.update).toHaveBeenCalledTimes(2);
    expect(state.petWindow.update).toHaveBeenLastCalledWith(owner7State);
  }),
);

it.effect("routes thread selection to the current owner only", () =>
  Effect.gen(function* () {
    state.ready = true;
    const { send7, send8, ownerWindow } = setupTwoOwners();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(runtime);
        const pet = Context.get(context, DesktopPet);
        yield* pet.open(7);
        yield* pet.open(8);
        state.onAction({ kind: "select-thread", environmentId: "env", threadId: "thread" });
        expect(ownerWindow.restore).toHaveBeenCalledOnce();
        expect(ownerWindow.show).toHaveBeenCalledOnce();
        expect(ownerWindow.focus).toHaveBeenCalledOnce();
        state.onAction({ kind: "set-pet", pet: "triton", movement: "static" });
      }),
    );
    expect(send8).toHaveBeenCalledWith(PET_ACTION_CHANNEL, {
      kind: "select-thread",
      environmentId: "env",
      threadId: "thread",
    });
    expect(send7).not.toHaveBeenCalledWith(PET_ACTION_CHANNEL, {
      kind: "select-thread",
      environmentId: "env",
      threadId: "thread",
    });
    expect(send7).toHaveBeenCalledWith(PET_ACTION_CHANNEL, {
      kind: "set-pet",
      pet: "triton",
      movement: "static",
    });
    expect(send8).toHaveBeenCalledWith(PET_ACTION_CHANNEL, {
      kind: "set-pet",
      pet: "triton",
      movement: "static",
    });
  }),
);

it.effect("explicit off clears every owner and syncs all renderers", () =>
  Effect.gen(function* () {
    state.ready = true;
    const { send7, send8 } = setupTwoOwners();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(runtime);
        const pet = Context.get(context, DesktopPet);
        yield* pet.open(7);
        yield* pet.open(8);
        yield* pet.setState(7, { pet: "off", movement: "static", threads: [] });
      }),
    );
    expect(state.petWindow.hide).toHaveBeenCalledOnce();
    expect(send7).toHaveBeenCalledWith(PET_ACTION_CHANNEL, { kind: "close" });
    expect(send8).toHaveBeenCalledWith(PET_ACTION_CHANNEL, { kind: "close" });
  }),
);
