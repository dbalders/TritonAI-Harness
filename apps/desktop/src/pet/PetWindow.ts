import * as Electron from "electron";
import {
  composePetFrame,
  petAnimationByName,
  petPixelColors,
  type PetId,
} from "@t3tools/shared/petCompanionSprites";
import type { DesktopPetState } from "@t3tools/contracts";

import { PET_WINDOW_ACTION_CHANNEL, PET_WINDOW_INPUT_CHANNEL } from "../ipc/channels.ts";
import { isPetWindowAction, type PetWindowAction } from "./petWindowAction.ts";

type PetFrameData = {
  readonly pixels: ReadonlyArray<readonly [string, number, number]>;
  readonly duration: number;
};

const ANIMATION_NAMES = [
  "idle",
  "running_right",
  "running_left",
  "wave",
  "failed",
  "waiting",
  "review",
] as const;

function frameDataFor(pet: PetId): Record<string, PetFrameData[]> {
  const result: Record<string, PetFrameData[]> = {};
  for (const name of ANIMATION_NAMES) {
    const animation = petAnimationByName(name);
    result[name] = animation.frames.map((frame) => ({
      pixels: petPixelColors(pet, composePetFrame(pet, frame.patches, frame.shift, frame.flip)),
      duration: frame.duration,
    }));
  }
  return result;
}

const DEFAULT_STATE: DesktopPetState = {
  pet: "triton",
  movement: "static",
  threads: [],
};

const PET_FRAME_DATA: Record<PetId, Record<string, PetFrameData[]>> = {
  triton: frameDataFor("triton"),
  trident: frameDataFor("trident"),
  raccoon: frameDataFor("raccoon"),
};

export function petHtml(): string {
  const frames = JSON.stringify(PET_FRAME_DATA);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden;
    font: 12px "Segoe UI", sans-serif; color: #fff; user-select: none; pointer-events: none; }
  .actor { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
  .sprite { position: absolute; left: 0; top: 0; width: 64px; height: 64px;
    pointer-events: auto; cursor: grab; touch-action: none; -webkit-app-region: drag; }
  .sprite:active { cursor: grabbing; }
  canvas { display: block; width: 64px; height: 64px; image-rendering: pixelated; }
  .pills { position: absolute; left: 0; bottom: 72px; display: grid; gap: 5px;
    width: max-content; max-width: 280px; pointer-events: auto; }
  .pills.below { bottom: auto; top: 72px; }
  .working { background: #38bdf8; }
  .review { background: #fbbf24; }
  .idle { background: #4ade80; }
  .failed { background: #f87171; }
  .pill, .menu button { border: 0; border-radius: 7px; padding: 5px 8px; cursor: default;
    text-align: left; color: #fff; font: inherit; background: rgba(15, 32, 66, .88);
    border: 1px solid rgba(255, 255, 255, .16); }
  .pill { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .pill:hover, .menu button:hover { background: rgba(0, 106, 150, .92); }
  .pill span { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
  .pill label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .more { color: rgba(255, 255, 255, .72); }
  .menu { position: absolute; left: 0; bottom: 72px; display: none; width: 124px;
    pointer-events: auto; }
  .menu.open { display: grid; gap: 4px; }
  .menu button { width: 100%; }
</style></head><body>
  <div class="actor" id="actor">
    <div class="sprite" id="sprite" data-interactive="true"><canvas id="pet" width="16" height="16" aria-hidden="true"></canvas></div>
    <div class="pills" id="pills" data-interactive="true"></div>
    <div class="menu" id="menu" data-interactive="true">
      <button data-action="set-pet" data-value="triton">Triton</button>
      <button data-action="set-pet" data-value="trident">Trident</button>
      <button data-action="set-pet" data-value="raccoon">Raccoon</button>
      <button data-action="set-pet" data-value="off">Off</button>
      <button id="movement" data-action="movement">Static</button>
      <button data-action="close">Close</button>
    </div>
  </div>
<script>
  const frames = ${frames};
  const actor = document.getElementById("actor");
  const sprite = document.getElementById("sprite");
  const pet = document.getElementById("pet");
  const context = pet.getContext("2d");
  const pills = document.getElementById("pills");
  const menu = document.getElementById("menu");
  const movementButton = document.getElementById("movement");
  const bridge = window.t3PetBridge;
  let state = null;
  let timer = 0;
  let animation = "idle";
  const activityAnimation = () => state.threads[0]?.status === "review" ? "review" : state.threads[0]?.status === "failed" ? "failed" : "idle";
  let frameIndex = 0;
  let frameAt = 0;
  let x = Math.max(window.innerWidth - 84, 0);
  let y = Math.max(window.innerHeight - 84, 0);
  let wanderUntil = 0;
  let moveUntil = 0;
  let direction = 1;

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  const petFrames = () => frames[state.pet][animation] ?? frames[state.pet].idle;
  const draw = () => {
    const items = petFrames();
    const item = items[Math.min(frameIndex, items.length - 1)];
    if (!item) return;
    context.clearRect(0, 0, 16, 16);
    for (const [color, pixelX, pixelY] of item.pixels) {
      context.fillStyle = color;
      context.fillRect(pixelX, pixelY, 1, 1);
    }
  };
  const setAnimation = (name) => {
    if (name === animation) return;
    animation = name;
    frameIndex = 0;
    frameAt = performance.now() / 1000;
    draw();
  };
  let menuOpen = false;
  const position = () => {
    x = clamp(x, 0, Math.max(window.innerWidth - 64, 0));
    y = clamp(y, 0, Math.max(window.innerHeight - 64, 0));
    actor.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
    for (const panel of [pills, menu]) {
      const box = panel.getBoundingClientRect();
      panel.style.left = clamp(x, 8, window.innerWidth - box.width - 8) - x + "px";
      panel.style.bottom = "auto";
      const top = y >= box.height + 8 ? y - box.height - 8 : y + 72;
      panel.style.top = clamp(top, 8, window.innerHeight - box.height - 8) - y + "px";
    }
    menu.classList.toggle("open", menuOpen);
  };
  const renderThreads = () => {
    const items = state.threads.slice(0, 3).map((thread) => {
      const button = document.createElement("button");
      button.className = "pill";
      button.title = thread.title;
      const dot = document.createElement("span");
      dot.className = thread.status;
      const label = document.createElement("label");
      label.textContent = thread.statusLabel
        ? thread.statusLabel + " - " + thread.title
        : thread.title;
      button.append(dot, label);
      button.addEventListener("click", () => bridge?.send({
        kind: "select-thread",
        environmentId: thread.environmentId,
        threadId: thread.threadId,
      }));
      return button;
    });
    if (state.threads.length > 3) {
      const more = document.createElement("div");
      more.className = "pill more";
      more.textContent = "+" + (state.threads.length - 3) + " more";
      items.push(more);
    }
    pills.replaceChildren(...items);
  };
  const update = () => {
    const now = performance.now() / 1000;
    const items = petFrames();
    if (now - frameAt >= items[frameIndex].duration) {
      frameIndex = (frameIndex + 1) % items.length;
      frameAt = now;
      draw();
    }
    if (state.movement === "playful" && !state.threads.some(thread => thread.status === "working" || thread.status === "review" || thread.status === "waiting")) {
      if (moveUntil > now) {
        x = clamp(x + direction * 18 * 0.04, 0, Math.max(window.innerWidth - 64, 0));
        position();
      } else if (now >= wanderUntil) {
        direction = Math.random() < 0.5 ? 1 : -1;
        setAnimation(direction > 0 ? "running_right" : "running_left");
        moveUntil = now + 1.5;
        wanderUntil = now + 20 + Math.random() * 15;
      } else if (animation.startsWith("running")) {
        setAnimation("idle");
      }
    }
  };
  let interactive = false;
  document.addEventListener("mousemove", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const nextInteractive = Boolean(target?.closest("[data-interactive]"));
    if (nextInteractive === interactive) return;
    interactive = nextInteractive;
    bridge?.setInteractive(interactive);
  });
  const setMenu = (open) => {
    menuOpen = open;
    menu.classList.toggle("open", menuOpen);
    position();
  };
  sprite.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    setMenu(!menuOpen);
  });
  menu.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (!button) return;
    setMenu(false);
    if (button.dataset.action === "close") bridge?.send({ kind: "close" });
    if (button.dataset.action === "movement") {
      bridge?.send({ kind: "set-movement", movement: state.movement === "static" ? "playful" : "static" });
    }
    if (button.dataset.action === "set-pet") bridge?.send({ kind: "set-pet", pet: button.dataset.value });
  });
  window.addEventListener("resize", position);
  window.__suspendPet = () => { clearInterval(timer); timer = 0; };
  window.__updatePet = (next) => {
    state = next;
    movementButton.textContent = state.movement === "static" ? "Playful" : "Static";
    renderThreads();
    setAnimation(activityAnimation());
    if (state.movement === "static") moveUntil = 0;
    if (!timer) timer = setInterval(update, 40);
    position();
    draw();
  };
  window.__updatePet(${JSON.stringify(DEFAULT_STATE)});
</script></body></html>`;
}

export function makePetWindow(
  platform: NodeJS.Platform,
  preloadPath: string,
  onAction: (action: PetWindowAction) => void,
) {
  let current: Electron.BrowserWindow | null = null;
  let latestState: DesktopPetState = DEFAULT_STATE;
  let visible = false;

  const isPetSender = (sender: Electron.WebContents) =>
    current !== null && !current.isDestroyed() && sender.id === current.webContents.id;
  const actionListener = (event: Electron.IpcMainEvent, action: unknown) => {
    if (!isPetSender(event.sender) || !isPetWindowAction(action)) return;
    onAction(action);
  };
  const inputListener = (event: Electron.IpcMainEvent, interactive: unknown) => {
    if (!isPetSender(event.sender) || typeof interactive !== "boolean") return;
    const window = current;
    if (window === null) return;
    const options = { forward: !interactive };
    window.setIgnoreMouseEvents(!interactive, options);
  };
  Electron.ipcMain.on(PET_WINDOW_ACTION_CHANNEL, actionListener);
  Electron.ipcMain.on(PET_WINDOW_INPUT_CHANNEL, inputListener);

  const show = (area: Electron.Rectangle) => {
    visible = true;
    if (current !== null && !current.isDestroyed()) {
      current.setBounds(area);
      current.showInactive();
      return;
    }
    const window = new Electron.BrowserWindow({
      ...area,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      focusable: false,
      frame: false,
      fullscreenable: false,
      hasShadow: false,
      maximizable: false,
      minimizable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      title: "TritonAI Harness pet",
      transparent: true,
      ...(platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
        sandbox: true,
      },
    });
    current = window;
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.setIgnoreMouseEvents(true, { forward: true });
    window.on("closed", () => {
      if (current === window) current = null;
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.once("ready-to-show", () => {
      if (visible && current === window && !window.isDestroyed()) {
        window.showInactive();
        update(latestState);
      }
    });
    void window
      .loadURL("data:text/html;charset=utf-8," + encodeURIComponent(petHtml()))
      .catch(() => undefined);
  };
  const update = (state: DesktopPetState) => {
    latestState = state;
    const window = current;
    if (window === null || window.isDestroyed()) return;
    void window.webContents
      .executeJavaScript(`window.__updatePet(${JSON.stringify(state)})`, true)
      .catch(() => undefined);
  };
  const hide = () => {
    visible = false;
    const window = current;
    if (window === null || window.isDestroyed()) return;
    window.hide();
    void window.webContents.executeJavaScript("window.__suspendPet?.()").catch(() => undefined);
  };
  const destroy = () => {
    visible = false;
    const window = current;
    current = null;
    if (window !== null && !window.isDestroyed()) window.destroy();
    Electron.ipcMain.removeListener(PET_WINDOW_ACTION_CHANNEL, actionListener);
    Electron.ipcMain.removeListener(PET_WINDOW_INPUT_CHANNEL, inputListener);
  };
  return { show, update, hide, destroy };
}
