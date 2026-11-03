import { contextBridge, ipcRenderer } from "electron";

import { isPetWindowAction } from "./pet/petWindowAction.ts";
import { PET_WINDOW_ACTION_CHANNEL, PET_WINDOW_INPUT_CHANNEL } from "./ipc/channels.ts";

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
});
