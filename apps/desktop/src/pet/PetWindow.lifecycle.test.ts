import * as E from "electron";
import { expect, it, vi } from "vite-plus/test";
import {
  PET_WINDOW_BOUNDS_CHANNEL,
  PET_WINDOW_DRAG_CHANNEL,
  PET_WINDOW_MOVE_CHANNEL,
} from "../ipc/channels.ts";
import { makePetWindow } from "./PetWindow.ts";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  screen: { getCursorScreenPoint: vi.fn() },
}));

function makeLinuxOverlayWindow() {
  const noop = () => {};
  return {
    webContents: {
      id: 99,
      on: noop,
      setWindowOpenHandler: noop,
      executeJavaScript: async () => {},
      send: noop,
    },
    isDestroyed: () => false,
    setBounds: noop,
    setAlwaysOnTop: noop,
    setVisibleOnAllWorkspaces: noop,
    setIgnoreMouseEvents: vi.fn(),
    setShape: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    on: noop,
    once: noop,
    loadURL: async () => {},
  };
}

it("keeps a late-loading pet hidden after Off and allows reopening", () => {
  const noop = () => {};
  let ready = noop;
  const w = {
    webContents: {
      id: 99,
      on: noop,
      setWindowOpenHandler: noop,
      executeJavaScript: async () => {},
      send: noop,
    },
    isDestroyed: () => false,
    setBounds: noop,
    setAlwaysOnTop: noop,
    setVisibleOnAllWorkspaces: noop,
    setIgnoreMouseEvents: noop,
    showInactive: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    on: noop,
    once: (name: string, fn: () => void) => {
      if (name === "ready-to-show") ready = fn;
    },
    loadURL: async () => {},
  };
  vi.mocked(E.BrowserWindow).mockImplementation(function () {
    return w as unknown as E.BrowserWindow;
  });
  const pet = makePetWindow("win32", "petPreload.cjs", noop);
  const areas = [{ id: 1, area: { x: 0, y: 0, width: 1920, height: 1080 } }];
  pet.show(areas);
  pet.hide();
  ready();
  expect(w.showInactive).not.toHaveBeenCalled();
  pet.show(areas);
  expect(w.showInactive).toHaveBeenCalledOnce();
  pet.destroy();
  expect(w.destroy).toHaveBeenCalledOnce();
});

it("enables Linux input only near the pet", () => {
  vi.useFakeTimers();
  const noop = () => {};
  const setIgnoreMouseEvents = vi.fn();
  const w = {
    webContents: {
      id: 99,
      on: noop,
      setWindowOpenHandler: noop,
      executeJavaScript: async () => {},
      send: noop,
    },
    isDestroyed: () => false,
    setBounds: noop,
    setAlwaysOnTop: noop,
    setVisibleOnAllWorkspaces: noop,
    setIgnoreMouseEvents,
    showInactive: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    on: noop,
    once: noop,
    loadURL: async () => {},
  };
  vi.mocked(E.BrowserWindow).mockImplementation(function () {
    return w as unknown as E.BrowserWindow;
  });
  const pet = makePetWindow("linux", "petPreload.cjs", noop, { XDG_SESSION_TYPE: "x11" });
  pet.show([{ id: 1, area: { x: 0, y: 0, width: 1920, height: 1080 } }]);
  const cursor = vi.mocked(E.screen.getCursorScreenPoint);
  cursor.mockReturnValue({ x: 100, y: 100 });
  vi.advanceTimersByTime(50);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  cursor.mockReturnValue({ x: 1850, y: 1000 });
  vi.advanceTimersByTime(50);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  pet.destroy();
  vi.useRealTimers();
});

it("keeps Linux Wayland overlays display-only", () => {
  vi.useFakeTimers();
  const w = makeLinuxOverlayWindow();
  vi.mocked(E.BrowserWindow).mockImplementation(function () {
    return w as unknown as E.BrowserWindow;
  });
  const pet = makePetWindow("linux", "petPreload.cjs", () => {}, {
    XDG_SESSION_TYPE: "wayland",
  });
  pet.show([{ id: 1, area: { x: 0, y: 0, width: 1920, height: 1080 } }]);
  expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  expect(w.setShape).not.toHaveBeenCalled();
  const cursor = vi.mocked(E.screen.getCursorScreenPoint);
  cursor.mockClear();
  w.setIgnoreMouseEvents.mockClear();
  vi.advanceTimersByTime(100);
  expect(cursor).not.toHaveBeenCalled();
  expect(w.setIgnoreMouseEvents).not.toHaveBeenCalled();
  expect(w.setShape).not.toHaveBeenCalled();
  const calls = vi.mocked(E.ipcMain.on).mock.calls;
  const dragListener = calls.filter(([channel]) => channel === PET_WINDOW_DRAG_CHANNEL).at(-1)![1];
  dragListener({ sender: w.webContents } as never, {
    kind: "start",
    offsetX: 0,
    offsetY: 0,
    screenX: 500,
    screenY: 500,
  });
  dragListener({ sender: w.webContents } as never, { kind: "end" });
  expect(w.setIgnoreMouseEvents).not.toHaveBeenCalled();
  expect(w.setShape).not.toHaveBeenCalled();
  pet.destroy();
  vi.useRealTimers();
});

it("keeps Linux overlays display-only when the session type is unset", () => {
  vi.useFakeTimers();
  const w = makeLinuxOverlayWindow();
  vi.mocked(E.BrowserWindow).mockImplementation(function () {
    return w as unknown as E.BrowserWindow;
  });
  const pet = makePetWindow("linux", "petPreload.cjs", () => {}, {});
  pet.show([{ id: 1, area: { x: 0, y: 0, width: 1920, height: 1080 } }]);
  expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  expect(w.setShape).not.toHaveBeenCalled();
  const cursor = vi.mocked(E.screen.getCursorScreenPoint);
  cursor.mockClear();
  w.setIgnoreMouseEvents.mockClear();
  vi.advanceTimersByTime(100);
  expect(cursor).not.toHaveBeenCalled();
  expect(w.setIgnoreMouseEvents).not.toHaveBeenCalled();
  expect(w.setShape).not.toHaveBeenCalled();
  pet.destroy();
  vi.useRealTimers();
});

it("uses reported Linux control bounds and keeps drags interactive", () => {
  vi.useFakeTimers();
  const noop = () => {};
  const setIgnoreMouseEvents = vi.fn();
  const w = {
    webContents: {
      id: 99,
      on: noop,
      setWindowOpenHandler: noop,
      executeJavaScript: async () => {},
      send: noop,
    },
    isDestroyed: () => false,
    setBounds: noop,
    setAlwaysOnTop: noop,
    setVisibleOnAllWorkspaces: noop,
    setIgnoreMouseEvents,
    showInactive: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    on: noop,
    once: noop,
    loadURL: async () => {},
  };
  vi.mocked(E.BrowserWindow).mockImplementation(function () {
    return w as unknown as E.BrowserWindow;
  });
  const pet = makePetWindow("linux", "petPreload.cjs", noop, { XDG_SESSION_TYPE: "x11" });
  pet.show([{ id: 1, area: { x: 0, y: 0, width: 1920, height: 1080 } }]);
  const calls = vi.mocked(E.ipcMain.on).mock.calls;
  const boundsCall = calls.filter(([channel]) => channel === PET_WINDOW_BOUNDS_CHANNEL).at(-1);
  const dragCall = calls.filter(([channel]) => channel === PET_WINDOW_DRAG_CHANNEL).at(-1);
  expect(boundsCall).toBeDefined();
  expect(dragCall).toBeDefined();
  const boundsListener = boundsCall![1];
  const dragListener = dragCall![1];
  const cursor = vi.mocked(E.screen.getCursorScreenPoint);
  cursor.mockReturnValue({ x: 100, y: 100 });
  vi.advanceTimersByTime(50);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  boundsListener({ sender: w.webContents } as never, { x: 1632, y: 868, width: 280, height: 192 });
  cursor.mockReturnValue({ x: 1700, y: 900 });
  vi.advanceTimersByTime(50);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  cursor.mockReturnValue({ x: 100, y: 100 });
  vi.advanceTimersByTime(50);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  dragListener({ sender: w.webContents } as never, { kind: "start", offsetX: 0, offsetY: 0 });
  vi.advanceTimersByTime(50);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  dragListener({ sender: w.webContents } as never, { kind: "end" });
  cursor.mockReturnValue({ x: 10, y: 10 });
  vi.advanceTimersByTime(50);
  expect(setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  pet.destroy();
  vi.useRealTimers();
});

it("restores an offscreen sprite when a drag ends", () => {
  const noop = () => {};
  const send = vi.fn();
  const w = {
    webContents: {
      id: 99,
      on: noop,
      setWindowOpenHandler: noop,
      executeJavaScript: async () => {},
      send,
    },
    isDestroyed: () => false,
    setBounds: noop,
    setAlwaysOnTop: noop,
    setVisibleOnAllWorkspaces: noop,
    setIgnoreMouseEvents: noop,
    showInactive: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    on: noop,
    once: noop,
    loadURL: async () => {},
  };
  vi.mocked(E.BrowserWindow).mockImplementation(function () {
    return w as unknown as E.BrowserWindow;
  });
  const pet = makePetWindow("win32", "petPreload.cjs", noop);
  pet.show([{ id: 1, area: { x: 0, y: 0, width: 1920, height: 1040 } }]);
  send.mockClear();
  const dragCall = vi
    .mocked(E.ipcMain.on)
    .mock.calls.filter(([channel]) => channel === PET_WINDOW_DRAG_CHANNEL)
    .at(-1);
  const dragListener = dragCall![1];
  vi.mocked(E.screen.getCursorScreenPoint).mockReturnValue({ x: 500, y: 1079 });
  dragListener({ sender: w.webContents } as never, { kind: "start", offsetX: 0, offsetY: 0 });
  dragListener({ sender: w.webContents } as never, { kind: "move", offsetX: 0, offsetY: 0 });
  expect(send).toHaveBeenLastCalledWith(PET_WINDOW_MOVE_CHANNEL, -64, -64);
  dragListener({ sender: w.webContents } as never, { kind: "end" });
  expect(send).toHaveBeenLastCalledWith(PET_WINDOW_MOVE_CHANNEL, 500, 976);
  pet.destroy();
});

it("moves one playful pet across adjacent displays", () => {
  vi.useFakeTimers();
  const noop = () => {};
  const makeWindow = (id: number, send: ReturnType<typeof vi.fn>) => ({
    webContents: {
      id,
      on: noop,
      setWindowOpenHandler: noop,
      executeJavaScript: async () => {},
      send,
    },
    isDestroyed: () => false,
    setBounds: noop,
    setAlwaysOnTop: noop,
    setVisibleOnAllWorkspaces: noop,
    setIgnoreMouseEvents: noop,
    showInactive: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    on: noop,
    once: noop,
    loadURL: async () => {},
  });
  const first = makeWindow(101, vi.fn());
  const second = makeWindow(102, vi.fn());
  const windows = [first, second];
  vi.mocked(E.BrowserWindow).mockImplementation(function () {
    return windows.shift() as unknown as E.BrowserWindow;
  });
  const pet = makePetWindow("win32", "petPreload.cjs", noop);
  pet.show(
    [
      { id: 1, area: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, area: { x: 1920, y: 0, width: 1920, height: 1080 } },
    ],
    { x: 1900, y: 500 },
  );
  pet.update({ pet: "triton", movement: "playful", threads: [] });
  vi.advanceTimersByTime(40);
  vi.advanceTimersByTime(40);
  expect(first.webContents.send).toHaveBeenLastCalledWith(PET_WINDOW_MOVE_CHANNEL, 1901, 500);
  expect(second.webContents.send).toHaveBeenLastCalledWith(PET_WINDOW_MOVE_CHANNEL, -19, 500);
  pet.destroy();
  vi.useRealTimers();
});
