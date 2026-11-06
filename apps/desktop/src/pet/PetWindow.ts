import * as Electron from "electron";
import {
  composePetFrame,
  petAnimationByName,
  petPixelColors,
  type PetId,
} from "@t3tools/shared/petCompanionSprites";
import type { DesktopPetState } from "@t3tools/contracts";

import {
  PET_WINDOW_ACTION_CHANNEL,
  PET_WINDOW_BOUNDS_CHANNEL,
  PET_WINDOW_DRAG_CHANNEL,
  PET_WINDOW_INPUT_CHANNEL,
  PET_WINDOW_MOVE_CHANNEL,
} from "../ipc/channels.ts";
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

export function petHtml(initialSpritePosition?: {
  readonly x: number;
  readonly y: number;
}): string {
  const frames = JSON.stringify(PET_FRAME_DATA);
  const initialSprite = initialSpritePosition ? JSON.stringify(initialSpritePosition) : "null";
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden;
    font: 12px "Segoe UI", sans-serif; color: #fff; user-select: none; pointer-events: none; }
  .actor { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
  .sprite { position: absolute; left: 0; top: 0; width: 64px; height: 64px;
    pointer-events: auto; cursor: grab; touch-action: none; }
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
  const initialSpritePosition = ${initialSprite};
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
  let x = initialSpritePosition ? initialSpritePosition.x : Math.max(window.innerWidth - 84, 0);
  let y = initialSpritePosition ? initialSpritePosition.y : Math.max(window.innerHeight - 84, 0);
  let wanderUntil = 0;
  let moveUntil = 0;
  let direction = 1;
  let drag = null;
  let onScreen = x > -64 && y > -64 && x < window.innerWidth && y < window.innerHeight;

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
  let lastBounds = null;
  const sameBounds = (a, b) =>
    a === b || Boolean(a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
  // Linux cannot forward ignored mouse events, so the main process needs the
  // real control bounds to decide where the pet window should accept input.
  const reportControlBounds = () => {
    if (!bridge?.reportBounds) return;
    let next = null;
    if (onScreen) {
      let left = x, top = y, right = x + 64, bottom = y + 64;
      for (const panel of [pills, menu]) {
        const box = panel.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) continue;
        const panelLeft = x + (parseFloat(panel.style.left) || 0);
        const panelTop = y + (parseFloat(panel.style.top) || 0);
        left = Math.min(left, panelLeft);
        top = Math.min(top, panelTop);
        right = Math.max(right, panelLeft + box.width);
        bottom = Math.max(bottom, panelTop + box.height);
      }
      next = { x: left, y: top, width: right - left, height: bottom - top };
    }
    if (sameBounds(lastBounds, next)) return;
    lastBounds = next;
    bridge.reportBounds(next);
  };
  const position = (bounded = true) => {
    if (bounded && onScreen) {
      x = clamp(x, 0, Math.max(window.innerWidth - 64, 0));
      y = clamp(y, 0, Math.max(window.innerHeight - 64, 0));
    }
    actor.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
    for (const panel of [pills, menu]) {
      if (!onScreen) {
        panel.style.visibility = "hidden";
        continue;
      }
      panel.style.visibility = "visible";
      const box = panel.getBoundingClientRect();
      panel.style.left = clamp(x, 8, window.innerWidth - box.width - 8) - x + "px";
      panel.style.bottom = "auto";
      const top = y >= box.height + 8 ? y - box.height - 8 : y + 72;
      panel.style.top = clamp(top, 8, window.innerHeight - box.height - 8) - y + "px";
    }
    menu.classList.toggle("open", menuOpen);
    reportControlBounds();
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
    if (!drag && onScreen && state.movement === "playful" && !state.threads.some(thread => thread.status === "working" || thread.status === "review" || thread.status === "waiting")) {
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
    const nextInteractive = Boolean(drag || target?.closest("[data-interactive]"));
    if (nextInteractive === interactive) return;
    interactive = nextInteractive;
    bridge?.setInteractive(interactive);
  });
  sprite.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    sprite.setPointerCapture(event.pointerId);
    drag = {
      id: event.pointerId,
      offsetX: event.clientX - x,
      offsetY: event.clientY - y,
    };
    bridge?.sendDrag({
      kind: "start",
      offsetX: drag.offsetX,
      offsetY: drag.offsetY,
      screenX: event.screenX,
      screenY: event.screenY,
    });
    setAnimation("wave");
  });
  sprite.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    // The main process owns drag position. Local pointer coordinates disagree
    // with screen coordinates when a captured pointer crosses a scaled display.
    bridge?.sendDrag({
      kind: "move",
      offsetX: drag.offsetX,
      offsetY: drag.offsetY,
      screenX: event.screenX,
      screenY: event.screenY,
    });
  });
  const endDrag = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    if (sprite.hasPointerCapture(event.pointerId)) sprite.releasePointerCapture(event.pointerId);
    bridge?.sendDrag({ kind: "end" });
    drag = null;
    setAnimation(activityAnimation());
  };
  sprite.addEventListener("pointerup", endDrag);
  sprite.addEventListener("pointercancel", endDrag);
  const setMenu = (open) => {
    menuOpen = open;
    menu.classList.toggle("open", menuOpen);
    position(false);
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
  window.addEventListener("resize", () => position(false));
  const movePet = (nextX, nextY) => {
    x = nextX;
    y = nextY;
    const nextOnScreen = nextX > -64 && nextY > -64 && nextX < window.innerWidth && nextY < window.innerHeight;
    if (!nextOnScreen && menuOpen) {
      menuOpen = false;
      menu.classList.toggle("open", false);
    }
    onScreen = nextOnScreen;
    position(false);
  };
  bridge?.onMove?.(movePet);
  window.__movePet = movePet;
  window.__suspendPet = () => { clearInterval(timer); timer = 0; };
  window.__updatePet = (next) => {
    state = next;
    movementButton.textContent = state.movement === "static" ? "Playful" : "Static";
    renderThreads();
    setAnimation(activityAnimation());
    if (state.movement === "static") moveUntil = 0;
    if (!timer) timer = setInterval(update, 40);
    // The main process owns sprite coordinates. An overlay may sit partially
    // offscreen when the pet straddles displays, so state updates must not
    // clamp it onto its own display and duplicate the sprite.
    position(false);
    draw();
  };
  window.__updatePet(${JSON.stringify(DEFAULT_STATE)});
</script></body></html>`;
}

export type PetWindowArea = {
  readonly id: number;
  readonly area: Electron.Rectangle;
};

type PetWindowBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type PetWindowEntry = {
  id: number;
  area: Electron.Rectangle;
  window: Electron.BrowserWindow;
  spriteVisible: boolean;
  controlBounds: PetWindowBounds | null;
};

type PetWindowDragEvent = {
  readonly kind: "start" | "move" | "end";
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly screenX?: number;
  readonly screenY?: number;
};

const PET_SIZE = 64;

function isPetWindowDragEvent(value: unknown): value is PetWindowDragEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as {
    kind?: unknown;
    offsetX?: unknown;
    offsetY?: unknown;
    screenX?: unknown;
    screenY?: unknown;
  };
  if (event.kind === "end") return true;
  if (event.kind !== "start" && event.kind !== "move") return false;
  if (typeof event.offsetX !== "number" || typeof event.offsetY !== "number") return false;
  if (event.screenX !== undefined && typeof event.screenX !== "number") return false;
  if (event.screenY !== undefined && typeof event.screenY !== "number") return false;
  return true;
}

export function makePetWindow(
  platform: NodeJS.Platform,
  preloadPath: string,
  onAction: (action: PetWindowAction) => void,
  environment: NodeJS.ProcessEnv = process.env,
) {
  let entries: PetWindowEntry[] = [];
  let latestState: DesktopPetState = DEFAULT_STATE;
  let visible = false;
  let spritePosition: { x: number; y: number } | null = null;
  let dragOffset: { x: number; y: number } | null = null;
  // Linux has no cross-platform mouse-event forwarding. X11 sessions poll the
  // cursor; every other Linux session (native Wayland, unset session type)
  // uses BrowserWindow.setShape so only the pet region receives input.
  const linuxX11Input =
    platform === "linux" && environment.XDG_SESSION_TYPE?.toLowerCase() === "x11";
  const linuxShapeInput = platform === "linux" && !linuxX11Input;

  const entryForSender = (sender: Electron.WebContents) =>
    entries.find(
      (entry) => !entry.window.isDestroyed() && entry.window.webContents.id === sender.id,
    );
  const stopDrag = () => {
    dragOffset = null;
  };
  const setSpritePosition = (next: { x: number; y: number }) => {
    const moved =
      spritePosition === null || spritePosition.x !== next.x || spritePosition.y !== next.y;
    spritePosition = next;
    for (const entry of entries) {
      // Renderer control bounds describe the previous sprite position; drop
      // them on movement so input follows the pet until fresh bounds arrive.
      if (moved) entry.controlBounds = null;
      if (entry.window.isDestroyed()) continue;
      const overlaps =
        next.x < entry.area.x + entry.area.width &&
        next.x + PET_SIZE > entry.area.x &&
        next.y < entry.area.y + entry.area.height &&
        next.y + PET_SIZE > entry.area.y;
      if (!overlaps && !entry.spriteVisible) continue;
      const x = overlaps ? Math.round(next.x - entry.area.x) : -PET_SIZE;
      const y = overlaps ? Math.round(next.y - entry.area.y) : -PET_SIZE;
      entry.window.webContents.send(PET_WINDOW_MOVE_CHANNEL, x, y);
      entry.spriteVisible = overlaps;
    }
    applyLinuxShapes();
  };
  const sendState = (entry: PetWindowEntry) => {
    if (entry.window.isDestroyed()) return;
    void entry.window.webContents
      .executeJavaScript(`window.__updatePet(${JSON.stringify(latestState)})`, true)
      .catch(() => undefined);
  };
  const createEntry = (display: PetWindowArea) => {
    const initial = spritePosition ?? {
      x: display.area.x + display.area.width - 84,
      y: display.area.y + display.area.height - 84,
    };
    const window = new Electron.BrowserWindow({
      ...display.area,
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
    const entry: PetWindowEntry = {
      id: display.id,
      area: display.area,
      window,
      spriteVisible: false,
      controlBounds: null,
    };
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    if (linuxShapeInput) {
      // Electron restores the full input region for an empty shape on some
      // Linux platforms, so make ignored input explicit alongside setShape.
      window.setIgnoreMouseEvents(true);
      window.setShape([]);
    } else {
      window.setIgnoreMouseEvents(true, platform === "linux" ? undefined : { forward: true });
    }
    window.on("closed", () => {
      entries = entries.filter((item) => item !== entry);
    });

    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.once("ready-to-show", () => {
      if (!visible || window.isDestroyed()) return;
      window.showInactive();
      sendState(entry);
      if (spritePosition !== null) setSpritePosition(spritePosition);
    });
    void window
      .loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            petHtml({ x: initial.x - display.area.x, y: initial.y - display.area.y }),
          ),
      )
      .catch(() => undefined);
    entries.push(entry);
    return entry;
  };

  const removeEntry = (entry: PetWindowEntry) => {
    if (!entry.window.isDestroyed()) entry.window.destroy();
    entries = entries.filter((item) => item !== entry);
  };
  const clampNumber = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max));
  const normalizeSpritePosition = (areas: readonly PetWindowArea[]) => {
    if (spritePosition === null || areas.length === 0) return;
    const intersects = areas.some(
      ({ area }) =>
        spritePosition !== null &&
        spritePosition.x < area.x + area.width &&
        spritePosition.x + PET_SIZE > area.x &&
        spritePosition.y < area.y + area.height &&
        spritePosition.y + PET_SIZE > area.y,
    );
    if (intersects) return;
    const area = areas[0]!.area;
    spritePosition = {
      x: clampNumber(spritePosition.x, area.x, area.x + area.width - PET_SIZE),
      y: clampNumber(spritePosition.y, area.y, area.y + area.height - PET_SIZE),
    };
  };

  const show = (
    areas: readonly PetWindowArea[],
    initialSpritePosition?: { readonly x: number; readonly y: number },
  ) => {
    visible = true;
    if (initialSpritePosition) spritePosition = { ...initialSpritePosition };
    if (spritePosition === null && areas.length > 0) {
      const area = areas[0]!.area;
      spritePosition = { x: area.x + area.width - 84, y: area.y + area.height - 84 };
    }
    const nextAreas = new Map(areas.map((display) => [display.id, display]));
    for (const entry of entries) {
      if (!nextAreas.has(entry.id)) removeEntry(entry);
    }
    for (const display of areas) {
      const entry = entries.find((item) => item.id === display.id);
      if (entry) {
        entry.area = display.area;
        if (!entry.window.isDestroyed()) {
          entry.window.setBounds(display.area);
          entry.window.showInactive();
        }
        continue;
      }
      createEntry(display);
    }
    normalizeSpritePosition(areas);
    if (spritePosition !== null) setSpritePosition(spritePosition);
  };

  const interactiveRegion = (entry: PetWindowEntry) => {
    if (spritePosition === null || !entry.spriteVisible) return null;
    if (entry.controlBounds !== null) {
      return {
        x: entry.area.x + entry.controlBounds.x,
        y: entry.area.y + entry.controlBounds.y,
        width: entry.controlBounds.width,
        height: entry.controlBounds.height,
      };
    }
    // Before the renderer reports control bounds, stay generous enough for
    // the sprite plus its default control layout.
    return {
      x: spritePosition.x - 16,
      y: spritePosition.y - 208,
      width: PET_SIZE + 312,
      height: PET_SIZE + 424,
    };
  };
  const applyLinuxShape = (entry: PetWindowEntry) => {
    if (entry.window.isDestroyed()) return;
    const active = visible && entry.spriteVisible;
    entry.window.setIgnoreMouseEvents(!(active || dragOffset !== null));
    // A captured drag must keep receiving pointer events even while the
    // sprite crosses display boundaries, so the whole overlay stays active.
    if (dragOffset !== null) {
      entry.window.setShape([{ x: 0, y: 0, width: entry.area.width, height: entry.area.height }]);
      return;
    }
    if (!active) {
      entry.window.setShape([]);
      return;
    }
    const region = interactiveRegion(entry);
    if (region === null) {
      entry.window.setShape([]);
      return;
    }
    const left = Math.max(region.x, entry.area.x);
    const top = Math.max(region.y, entry.area.y);
    const right = Math.min(region.x + region.width, entry.area.x + entry.area.width);
    const bottom = Math.min(region.y + region.height, entry.area.y + entry.area.height);
    if (right <= left || bottom <= top) {
      entry.window.setShape([]);
      return;
    }
    entry.window.setShape([
      {
        x: Math.round(left - entry.area.x),
        y: Math.round(top - entry.area.y),
        width: Math.round(right - left),
        height: Math.round(bottom - top),
      },
    ]);
  };
  const applyLinuxShapes = () => {
    if (!linuxShapeInput) return;
    for (const entry of entries) applyLinuxShape(entry);
  };
  // Electron only forwards ignored mouse events on macOS and Windows. On
  // Linux X11, poll the cursor and enable input only around the pet controls.
  const updateLinuxInput = () => {
    if (!visible) return;
    const point = Electron.screen.getCursorScreenPoint();
    for (const entry of entries) {
      if (entry.window.isDestroyed()) continue;
      const region = interactiveRegion(entry);
      // A captured drag must keep receiving pointer events even between
      // bounds reports, or Linux would drop the pointerup mid-drag.
      const interactive =
        dragOffset !== null ||
        (region !== null &&
          point.x >= region.x &&
          point.x <= region.x + region.width &&
          point.y >= region.y &&
          point.y <= region.y + region.height);
      entry.window.setIgnoreMouseEvents(!interactive);
    }
  };
  // @effect-diagnostics-next-line globalTimers:off -- Electron cursor polling runs at a native callback boundary outside any Effect fiber.
  const linuxInputTimer = linuxX11Input ? setInterval(updateLinuxInput, 50) : null;
  const actionListener = (event: Electron.IpcMainEvent, action: unknown) => {
    if (entryForSender(event.sender) === undefined || !isPetWindowAction(action)) return;
    onAction(action);
  };
  const inputListener = (event: Electron.IpcMainEvent, interactive: unknown) => {
    if (platform === "linux") return;
    const entry = entryForSender(event.sender);
    if (entry === undefined || typeof interactive !== "boolean") return;
    if (!entry.window.isDestroyed()) {
      entry.window.setIgnoreMouseEvents(!interactive, { forward: !interactive });
    }
  };
  const boundsListener = (event: Electron.IpcMainEvent, bounds: unknown) => {
    const entry = entryForSender(event.sender);
    if (entry === undefined) return;
    if (bounds === null) {
      entry.controlBounds = null;
      applyLinuxShapes();
      return;
    }
    if (typeof bounds !== "object" || bounds === null) return;
    const { x, y, width, height } = bounds as Record<string, unknown>;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      return;
    }
    entry.controlBounds = { x, y, width, height };
    applyLinuxShapes();
  };
  const movePetToCursor = () => {
    if (dragOffset === null) return;
    const point = Electron.screen.getCursorScreenPoint();
    setSpritePosition({ x: point.x - dragOffset.x, y: point.y - dragOffset.y });
  };
  const dragListener = (event: Electron.IpcMainEvent, value: unknown) => {
    if (entryForSender(event.sender) === undefined || !isPetWindowDragEvent(value)) return;
    if (value.kind === "end") {
      stopDrag();
      normalizeSpritePosition(entries.map((entry) => ({ id: entry.id, area: entry.area })));
      if (spritePosition !== null) setSpritePosition(spritePosition);
      applyLinuxShapes();
      return;
    }
    dragOffset = { x: value.offsetX!, y: value.offsetY! };
    if (linuxShapeInput) {
      // getCursorScreenPoint is unavailable outside X11, so the renderer
      // reports its own screen coordinates with every drag event.
      if (
        value.screenX !== undefined &&
        value.screenY !== undefined &&
        Number.isFinite(value.screenX) &&
        Number.isFinite(value.screenY)
      ) {
        setSpritePosition({ x: value.screenX - dragOffset.x, y: value.screenY - dragOffset.y });
      }
      applyLinuxShapes();
      return;
    }
    // Renderer pointer events drive each update, so movement follows the
    // input cadence instead of a polling timer.
    movePetToCursor();
  };
  Electron.ipcMain.on(PET_WINDOW_ACTION_CHANNEL, actionListener);
  Electron.ipcMain.on(PET_WINDOW_INPUT_CHANNEL, inputListener);
  Electron.ipcMain.on(PET_WINDOW_DRAG_CHANNEL, dragListener);
  Electron.ipcMain.on(PET_WINDOW_BOUNDS_CHANNEL, boundsListener);

  const update = (state: DesktopPetState) => {
    latestState = state;
    for (const entry of entries) sendState(entry);
  };
  const hide = () => {
    visible = false;
    stopDrag();
    applyLinuxShapes();
    for (const entry of entries) {
      if (entry.window.isDestroyed()) continue;
      entry.window.hide();
      void entry.window.webContents
        .executeJavaScript("window.__suspendPet?.()")
        .catch(() => undefined);
    }
  };
  const destroy = () => {
    visible = false;
    stopDrag();
    if (linuxInputTimer !== null) clearInterval(linuxInputTimer);
    for (const entry of entries) removeEntry(entry);
    Electron.ipcMain.removeListener(PET_WINDOW_ACTION_CHANNEL, actionListener);
    Electron.ipcMain.removeListener(PET_WINDOW_INPUT_CHANNEL, inputListener);
    Electron.ipcMain.removeListener(PET_WINDOW_DRAG_CHANNEL, dragListener);
    Electron.ipcMain.removeListener(PET_WINDOW_BOUNDS_CHANNEL, boundsListener);
  };
  return { show, update, hide, destroy };
}
