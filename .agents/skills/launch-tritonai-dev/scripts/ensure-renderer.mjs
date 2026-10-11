#!/usr/bin/env node
// Confirms the TritonAI Harness dev desktop window actually rendered, and reloads it when the
// first cold load failed.
//
// On a cold start the renderer requests hundreds of unbundled Vite modules over the t3code-dev://
// protocol at once. Electron can answer some of them with net::ERR_INSUFFICIENT_RESOURCES, the
// entry import fails, and the window stays on the boot splash or shows "T3 Code could not load."
// Backend and Electron log lines ("backend ready", "main window created") still look healthy, so
// they are not proof the app loaded. React removes #boot-shell when the app mounts; that is the
// first readiness signal used here. One reload after Vite has warmed up reliably recovers.
//
// A mounted window can still be unusable: when another dev desktop holds the shared Electron
// userData, IndexedDB cannot open and the renderer never authenticates ("No projects yet"). After
// mounting, the window must open IndexedDB and hold an authenticated session with its backend.
//
// Usage: node ensure-renderer.mjs --repo <harness checkout> --port <remote debugging port>
//        [--timeout-seconds 240] [--max-reloads 3]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const repo = argument("repo", process.env.TRITONAI_HARNESS_REPO);
const port = Number(argument("port", process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT));
const timeoutMs = Number(argument("timeout-seconds", "240")) * 1000;
const receipt = argument("receipt");
const maxReloads = Number(argument("max-reloads", "3"));
const log = (message) => console.log(`[launch-tritonai-dev] ${message}`);

if (
  !repo ||
  !Number.isInteger(port) ||
  port <= 0 ||
  !Number.isFinite(timeoutMs) ||
  timeoutMs <= 0
) {
  console.error("ensure-renderer: pass --repo <harness checkout> and --port <debugging port>.");
  process.exit(2);
}

function findPlaywright() {
  const store = NodePath.join(repo, "node_modules", ".pnpm");
  const candidates = NodeFS.existsSync(store)
    ? NodeFS.readdirSync(store)
        .filter((name) => /^playwright-core@\d/u.test(name))
        .toSorted()
        .reverse()
    : [];
  for (const candidate of candidates) {
    const entry = NodePath.join(store, candidate, "node_modules", "playwright-core", "index.mjs");
    if (NodeFS.existsSync(entry)) return entry;
  }
  return null;
}

const playwrightEntry = findPlaywright();
if (!playwrightEntry) {
  console.error(`ensure-renderer: playwright-core is not installed under ${repo}/node_modules.`);
  process.exit(2);
}
const watchdog = setTimeout(() => {
  console.error("ensure-renderer: readiness deadline exceeded");
  process.exit(1);
}, timeoutMs);
watchdog.unref();

const { chromium } = await import(NodeURL.pathToFileURL(playwrightEntry).href);
const deadline = Date.now() + timeoutMs;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }
  throw new Error(`could not attach to the window on port ${port}: ${lastError?.message ?? ""}`);
}

async function appPage(browser) {
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (/^(t3code-dev|tritonai-harness[\w-]*|t3code):\/\/app\//u.test(page.url())) return page;
      }
    }
    await sleep(1_000);
  }
  throw new Error("the main app page never appeared");
}

// "mounted", "error" (boot error panel), or "booting" (splash still up).
async function state(page) {
  return page
    .evaluate(() => {
      if (document.getElementById("boot-error")) return "error";
      if (document.getElementById("boot-shell")) return "booting";
      const root = document.getElementById("root");
      return root && root.childElementCount > 0 ? "mounted" : "booting";
    })
    .catch(() => "booting");
}

// Probes from inside the renderer: can it open IndexedDB, and is its backend session authenticated?
async function connection(page) {
  return page
    .evaluate(async () => {
      let storage = "ok";
      try {
        await new Promise((resolve, reject) => {
          const request = indexedDB.open("launch-tritonai-dev-probe");
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
          request.onerror = () => reject(request.error);
        });
      } catch (error) {
        storage = String(error);
      }
      const bootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps?.();
      const primary = Array.isArray(bootstraps) ? bootstraps[0] : bootstraps;
      let authenticated = null;
      let backend = primary?.httpBaseUrl ?? null;
      if (backend) {
        try {
          // The desktop renderer authenticates with a bearer token from the desktop bridge, not a
          // cookie; fall back to cookies when no token is offered.
          const token = await window.desktopBridge?.getLocalEnvironmentBearerToken?.();
          const response = await fetch(new URL("/api/auth/session", backend), {
            credentials: "include",
            headers: typeof token === "string" && token ? { authorization: `Bearer ${token}` } : {},
          });
          authenticated = (await response.json())?.authenticated === true;
        } catch {
          authenticated = false;
        }
      }
      return { storage, authenticated, backend };
    })
    .catch((error) => ({ storage: String(error), authenticated: false, backend: null }));
}

async function waitForConnection(page, graceMs) {
  const until = Math.min(deadline, Date.now() + graceMs);
  let current = await connection(page);
  while (Date.now() < until && (current.storage !== "ok" || current.authenticated === false)) {
    if (current.storage !== "ok") return current;
    await sleep(1_000);
    current = await connection(page);
  }
  return current;
}

async function waitForMount(page, graceMs) {
  const until = Math.min(deadline, Date.now() + graceMs);
  while (Date.now() < until) {
    const current = await state(page);
    if (current !== "booting") return current;
    await sleep(1_000);
  }
  return state(page);
}

const browser = await connect();
try {
  const page = await appPage(browser);
  let reloads = 0;
  // A healthy cold start mounts well inside this window; the failure mode never mounts.
  let result = await waitForMount(page, 45_000);
  while (result !== "mounted" && reloads < maxReloads && Date.now() < deadline) {
    reloads += 1;
    log(`renderer did not mount (${result}); reloading (${reloads}/${maxReloads})`);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    result = await waitForMount(page, 60_000);
  }
  if (result !== "mounted") {
    log(`renderer NOT ready after ${reloads} reload(s): ${result}`);
    process.exitCode = 1;
  } else {
    let probe = await waitForConnection(page, 30_000);
    if (probe.storage === "ok" && probe.authenticated === false && reloads < maxReloads) {
      reloads += 1;
      log(`renderer mounted but is not authenticated; reloading (${reloads}/${maxReloads})`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      result = await waitForMount(page, 60_000);
      probe = await waitForConnection(page, 30_000);
    }
    if (result !== "mounted") {
      log(`renderer NOT ready after authentication reload: ${result}`);
      process.exitCode = 1;
    } else if (probe.storage !== "ok") {
      log(
        "renderer NOT ready: IndexedDB cannot open. Inspect this instance’s Electron profile and storage error; do not stop other instances.",
      );
      process.exitCode = 1;
    } else if (probe.authenticated !== true) {
      log(`renderer NOT ready: not authenticated with its backend (${probe.backend ?? "unknown"})`);
      process.exitCode = 1;
    } else {
      if (receipt)
        NodeFS.writeFileSync(
          receipt,
          `${JSON.stringify({ checkedAt: new Date().toISOString(), pageUrl: page.url(), backendUrl: probe.backend, debugPort: port, authenticated: true, storage: probe.storage, reloads }, null, 2)}\n`,
          { mode: 0o600 },
        );
      log(`renderer ready (${page.url()}, backend ${probe.backend}, reloads=${reloads})`);
    }
  }
} finally {
  // Disconnect only; never close the app window.
  await browser.close().catch(() => undefined);
  clearTimeout(watchdog);
}
