// @effect-diagnostics globalTimers:off -- Plain Electron window code outside any Effect fiber.
import * as Electron from "electron";

import type { ActiveRecording } from "./skillRecorder.ts";

const BAR_WIDTH = 320;
const BAR_HEIGHT = 44;
const BAR_TOP_MARGIN = 12;

export type SkillRecordingBarAction = "stop" | "discard";

function barHtml(maxDurationMs: number): string {
  const config = JSON.stringify({ maxDurationMs });
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body { font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #fff; user-select: none; }
  .bar { box-sizing: border-box; height: 100%; display: flex; align-items: center; gap: 8px;
    padding: 0 6px 0 12px; border-radius: 22px; background: rgba(32, 32, 34, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.12); -webkit-app-region: drag; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; flex: none; }
  .label { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .clock { font-variant-numeric: tabular-nums; color: #fca5a5; flex: none; }
  button { -webkit-app-region: no-drag; font: inherit; color: inherit; cursor: default;
    border: 0; border-radius: 16px; height: 30px; padding: 0 12px; flex: none; }
  .stop { background: #ef4444; }
  .stop:hover { background: #dc2626; }
  .discard { background: rgba(255, 255, 255, 0.1); }
  .discard:hover { background: rgba(255, 255, 255, 0.18); }
</style></head>
<body><div class="bar">
  <span class="dot"></span>
  <span class="label">Recording</span>
  <span class="clock" id="clock">0:00</span>
  <button class="discard" id="discard" title="Throw this recording away">Discard</button>
  <button class="stop" id="stop" title="Stop and talk the recording through in Harness">Stop</button>
</div>
<script>
  const config = ${config};
  const startedAt = Date.now();
  const clock = document.getElementById("clock");
  const format = (ms) => {
    const seconds = Math.floor(ms / 1000);
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  };
  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= config.maxDurationMs) {
      clearInterval(timer);
      clock.textContent = "Time limit";
      return;
    }
    clock.textContent = format(elapsed);
  }, 1000);
  // The main process reads choices from the title; this page has no bridge.
  let count = 0;
  const choose = (action) => { document.title = action + ":" + ++count; };
  document.getElementById("stop").addEventListener("click", () => choose("stop"));
  document.getElementById("discard").addEventListener("click", () => choose("discard"));
</script></body></html>`;
}

/** Reads a choice the bar page wrote into its title. */
export function parseSkillRecordingBarTitle(title: string): SkillRecordingBarAction | null {
  const action = title.split(":")[0];
  return action === "stop" || action === "discard" ? action : null;
}

/**
 * A small always-on-top bar that shows a recording is running while the user
 * works in another app, with Stop and Discard.
 */
export function makeSkillRecordingBar(
  platform: NodeJS.Platform,
  onAction: (recording: ActiveRecording, action: SkillRecordingBarAction) => void,
) {
  let current: {
    readonly window: Electron.BrowserWindow;
    readonly recording: ActiveRecording;
  } | null = null;

  const hide = () => {
    const window = current?.window;
    current = null;
    if (!window || window.isDestroyed()) return;
    // Hiding can be triggered from the bar's own click; let that event finish first.
    window.hide();
    setTimeout(() => {
      if (!window.isDestroyed()) window.destroy();
    }, 0);
  };

  const show = (recording: ActiveRecording) => {
    hide();
    const cursor = Electron.screen.getCursorScreenPoint();
    const area = Electron.screen.getDisplayNearestPoint(cursor).workArea;
    const window = new Electron.BrowserWindow({
      x: Math.round(area.x + (area.width - BAR_WIDTH) / 2),
      y: area.y + BAR_TOP_MARGIN,
      width: BAR_WIDTH,
      height: BAR_HEIGHT,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      focusable: false,
      frame: false,
      fullscreenable: false,
      hasShadow: true,
      maximizable: false,
      minimizable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      title: "TritonAI Harness recording",
      transparent: true,
      ...(platform === "darwin" ? { type: "panel" } : {}),
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const entry = { window, recording };
    current = entry;
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.webContents.on("page-title-updated", (event, title) => {
      event.preventDefault();
      const action = parseSkillRecordingBarTitle(title);
      if (action && current === entry) onAction(recording, action);
    });
    // The bar never navigates or opens anything.
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.once("ready-to-show", () => {
      if (current === entry && !window.isDestroyed()) window.showInactive();
    });
    void window
      .loadURL(
        "data:text/html;charset=utf-8," + encodeURIComponent(barHtml(recording.maxDurationMs)),
      )
      .catch(() => undefined);
  };

  return { show, hide };
}
