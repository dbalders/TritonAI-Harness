import * as E from "electron";
import { expect, it, vi } from "vite-plus/test";
import { PET_WINDOW_DRAG_CHANNEL } from "../ipc/channels.ts";
import { makePetWindow } from "./PetWindow.ts";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  screen: { getCursorScreenPoint: vi.fn() },
}));

it("keeps non-X11 Linux overlays click-through across displays", () => {
  vi.useFakeTimers();
  const noop = () => {};
  const makeWindow = (id: number) => ({
    webContents: {
      id,
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
  });
  const primary = makeWindow(91);
  const secondary = makeWindow(92);
  const windows = [primary, secondary];
  vi.mocked(E.BrowserWindow).mockImplementation(function () {
    return windows.shift() as unknown as E.BrowserWindow;
  });
  const pet = makePetWindow("linux", "petPreload.cjs", noop, {
    XDG_SESSION_TYPE: "wayland",
  });
  pet.show([
    { id: 1, area: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, area: { x: 1920, y: 0, width: 1080, height: 1920 } },
  ]);
  expect(primary.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  expect(secondary.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  expect(primary.setShape).not.toHaveBeenCalled();
  expect(secondary.setShape).not.toHaveBeenCalled();
  const cursor = vi.mocked(E.screen.getCursorScreenPoint);
  cursor.mockClear();
  primary.setIgnoreMouseEvents.mockClear();
  secondary.setIgnoreMouseEvents.mockClear();
  vi.advanceTimersByTime(200);
  expect(cursor).not.toHaveBeenCalled();
  expect(primary.setIgnoreMouseEvents).not.toHaveBeenCalled();
  expect(secondary.setIgnoreMouseEvents).not.toHaveBeenCalled();
  const calls = vi.mocked(E.ipcMain.on).mock.calls;
  const dragCall = calls.filter(([channel]) => channel === PET_WINDOW_DRAG_CHANNEL).at(-1);
  const dragListener = dragCall![1];
  dragListener({ sender: primary.webContents } as never, {
    kind: "start",
    offsetX: 0,
    offsetY: 0,
    screenX: 1836,
    screenY: 996,
  });
  dragListener({ sender: primary.webContents } as never, { kind: "end" });
  expect(primary.setIgnoreMouseEvents).not.toHaveBeenCalled();
  expect(secondary.setIgnoreMouseEvents).not.toHaveBeenCalled();
  expect(primary.setShape).not.toHaveBeenCalled();
  expect(secondary.setShape).not.toHaveBeenCalled();
  pet.destroy();
  vi.useRealTimers();
});
