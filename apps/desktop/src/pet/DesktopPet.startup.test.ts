import { it } from "@effect/vitest";
import { beforeEach, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
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
      { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
      { workArea: { x: 0, y: 0, width: 2560, height: 1440 } },
      { workArea: ownerBounds },
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
      { x: -1920, y: 0, width: 6400, height: 1440 },
      { x: 6316, y: 1096 },
    );
    expect(state.petWindow.hide).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  }),
);
