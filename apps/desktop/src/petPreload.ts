import { contextBridge, ipcRenderer } from "electron";

import { isPetWindowAction } from "./pet/petWindowAction.ts";
import {
  PET_WINDOW_ACTION_CHANNEL,
  PET_WINDOW_DRAG_CHANNEL,
  PET_WINDOW_INPUT_CHANNEL,
  PET_WINDOW_BOUNDS_CHANNEL,
  PET_WINDOW_MOVE_CHANNEL,
} from "./ipc/channels.ts";

// This preload belongs only to the floating pet overlay. It deliberately does
// not expose the general desktop bridge to the pet page.
contextBridge.exposeInMainWorld("t3PetBridge", {
  send: (action: unknown) => {
    if (!isPetWindowAction(action)) return;
    ipcRenderer.send(PET_WINDOW_ACTION_CHANNEL, action);
  },
  setInteractive: (interactive: unknown) => {
    if (typeof interactive !== "boolean") return;
    ipcRenderer.send(PET_WINDOW_INPUT_CHANNEL, interactive);
  },
  sendDrag: (event: unknown) => {
    ipcRenderer.send(PET_WINDOW_DRAG_CHANNEL, event);
  },
  reportBounds: (bounds: unknown) => {
    if (bounds !== null && typeof bounds !== "object") return;
    ipcRenderer.send(PET_WINDOW_BOUNDS_CHANNEL, bounds);
  },
  onMove: (handler: (x: number, y: number) => void) => {
    ipcRenderer.on(PET_WINDOW_MOVE_CHANNEL, (_event, x, y) => {
      if (typeof x === "number" && typeof y === "number") handler(x, y);
    });
  },
});
