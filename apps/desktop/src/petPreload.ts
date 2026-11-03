import { contextBridge, ipcRenderer } from "electron";

import { isPetWindowAction } from "./pet/petWindowAction.ts";
import {
  PET_WINDOW_ACTION_CHANNEL,
  PET_WINDOW_INPUT_CHANNEL,
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
  moveWindow: (dx: unknown, dy: unknown) => {
    if (typeof dx !== "number" || typeof dy !== "number") return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    ipcRenderer.send(PET_WINDOW_MOVE_CHANNEL, dx, dy);
  },
});
