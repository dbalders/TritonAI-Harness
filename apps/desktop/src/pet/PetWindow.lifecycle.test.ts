import * as E from "electron";
import { expect, it, vi } from "vite-plus/test";
import { makePetWindow } from "./PetWindow.ts";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
}));

it("keeps a late-loading pet hidden after Off and allows reopening", () => {
  const noop = () => {};
  let ready = noop;
  const w = {
    webContents: {
      id: 99,
      on: noop,
      setWindowOpenHandler: noop,
      executeJavaScript: async () => {},
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
