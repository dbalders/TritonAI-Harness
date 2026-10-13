#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";

const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const log = (message) => console.log(`[launch-tritonai-dev] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (repo, ...args) =>
  NodeChildProcess.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

export function processBirth(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    return (
      NodeChildProcess.execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export function ownerAlive(record) {
  return Boolean(record?.ownerBirth && processBirth(record.ownerPid) === record.ownerBirth);
}

export function ownedBackendGroups(directory) {
  if (!directory || !NodeFS.existsSync(directory)) return [];
  return NodeFS.readdirSync(directory).flatMap((name) => {
    if (!/^[1-9][0-9]*$/.test(name)) return [];
    const pid = Number(name);
    const birth = NodeFS.readFileSync(NodePath.join(directory, name), "utf8").trim();
    return birth && processBirth(pid) === birth && groupAlive(pid) ? [pid] : [];
  });
}

export function recordedBackendGroups(directory) {
  if (!directory || !NodeFS.existsSync(directory)) return [];
  return NodeFS.readdirSync(directory)
    .filter((name) => /^[1-9][0-9]*$/.test(name))
    .map(Number)
    .filter(groupAlive);
}

async function finishBackendRegistrations(directory) {
  if (!directory) return;
  NodeFS.writeFileSync(NodePath.join(directory, "stopping"), "stopping", { mode: 0o600 });
  const pending = () => NodeFS.readdirSync(directory).some((name) => name.startsWith("pending-"));
  for (let i = 0; i < 30 && pending(); i += 1) await sleep(100);
  if (pending())
    throw new Error(
      "Backend registration is still pending; inspect the owned instance before stopping it.",
    );
}

function groupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRecord(file) {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function stop(file) {
  const record = readRecord(file);
  if (!record) {
    log("no owned instance");
    return;
  }
  if (!ownerAlive(record)) {
    if (
      groupAlive(record.runnerPid) ||
      recordedBackendGroups(record.backendOwnersDirectory).length > 0
    )
      throw new Error(
        "The recorded supervisor exited but its process group remains. Inspect the recorded instance; no process was killed.",
      );
    log("recorded instance is stopped");
    return;
  }
  process.kill(record.ownerPid, "SIGTERM");
  for (let i = 0; i < 150 && ownerAlive(record); i += 1) await sleep(100);
  if (ownerAlive(record))
    throw new Error(
      "The owned instance did not stop within 15 seconds; no unrelated process was touched.",
    );
  log(`stopped ${record.branch} (${record.commit.slice(0, 12)})`);
}

export async function main(args = process.argv.slice(2)) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone process supervisor has no Effect runtime.
  const platform = NodeOS.platform();
  if (platform === "win32")
    throw new Error(
      "This retained-process launcher currently supports macOS and Linux. Desktop profile isolation itself also applies on Windows.",
    );
  const command = args[0] ?? "start";
  if (
    args.length > 1 ||
    !["start", "status", "stop", "restart", "--check-checkout"].includes(command)
  ) {
    throw new Error(
      "Usage: launch.sh [start|status|stop|restart|--check-checkout]. Select the checkout with TRITONAI_HARNESS_REPO.",
    );
  }
  const repo = NodeFS.realpathSync(
    process.env.TRITONAI_HARNESS_REPO || git(process.cwd(), "rev-parse", "--show-toplevel"),
  );
  const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(repo, "package.json"), "utf8"));
  if (pkg.name !== "@t3tools/monorepo" || !pkg.scripts?.["dev:desktop"])
    throw new Error("Select a Harness checkout with dev:desktop.");
  const directory = NodePath.join(repo, ".t3", "launch-tritonai-dev");
  const file = NodePath.join(directory, "instance.json");
  const lock = NodePath.join(directory, "owner.lock");
  if (command === "status") {
    const record = readRecord(file);
    console.log(
      JSON.stringify(
        record ? { ...record, ownerAlive: ownerAlive(record) } : { status: "stopped", repo },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "stop") return stop(file);
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error(
      "Use Node 24 from this checkout's package.json. Loading a managed gateway env may change PATH; restore the development Node directory before launching.",
    );
  }
  const branch = git(repo, "branch", "--show-current") || "detached";
  const commit = git(repo, "rev-parse", "HEAD");
  const dirty = git(repo, "status", "--porcelain").length > 0;
  log(`checkout ${repo}\nbranch=${branch} commit=${commit} dirty=${dirty}`);
  if (command === "--check-checkout") return;
  if (command === "restart") await stop(file);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const previous = readRecord(file);
  if (ownerAlive(previous)) {
    log("this checkout already has an owned instance; use status, or restart it explicitly");
    console.log(JSON.stringify(previous, null, 2));
    return;
  }
  if (
    previous &&
    (groupAlive(previous.runnerPid) ||
      recordedBackendGroups(previous.backendOwnersDirectory).length > 0)
  )
    throw new Error(
      "An earlier owned process group remains; inspect instance.json before restarting.",
    );
  // Never unlink a stale lock during launch: concurrent reclaimers could remove a new owner's lock.
  if (NodeFS.existsSync(lock)) {
    const lockedOwner = readRecord(lock);
    if (!lockedOwner || ownerAlive(lockedOwner))
      throw new Error("Another launch is in progress for this checkout.");
    throw new Error(
      `Stale launch lock at ${lock}. Confirm its recorded owner is gone, then remove only that lock before retrying.`,
    );
  }
  const owner = { ownerPid: process.pid, ownerBirth: processBirth(process.pid) };
  const lockFd = NodeFS.openSync(lock, "wx", 0o600);
  NodeFS.writeFileSync(lockFd, JSON.stringify(owner));
  NodeFS.closeSync(lockFd);
  let runner;
  let probe;
  let stopping;
  let record;
  const save = () => {
    NodeFS.writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    NodeFS.renameSync(`${file}.tmp`, file);
  };
  const cleanup = (code = 0) =>
    (stopping ??= (async () => {
      if (probe && probe.exitCode === null) probe.kill("SIGTERM");
      await finishBackendRegistrations(record?.backendOwnersDirectory);
      const groups = new Set(ownedBackendGroups(record?.backendOwnersDirectory));
      if (recordedBackendGroups(record?.backendOwnersDirectory).some((pid) => !groups.has(pid))) {
        throw new Error(
          "A recorded backend group survives without a verifiable leader; inspect it before stopping.",
        );
      }
      if (runner?.pid) groups.add(runner.pid);
      const signalGroups = (signal) => {
        for (const pid of groups) {
          try {
            process.kill(-pid, signal);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      };
      signalGroups("SIGTERM");
      for (let i = 0; i < 80 && [...groups].some(groupAlive); i += 1) await sleep(100);
      signalGroups("SIGKILL");
      if (record) {
        record.status = code ? "failed" : "stopped";
        save();
      }
      NodeFS.unlinkSync(lock);
      process.exitCode = code;
    })());
  const signal = () => {
    void cleanup();
  };
  process.once("SIGTERM", signal);
  process.once("SIGINT", signal);
  process.once("SIGHUP", signal);
  try {
    const debugPort = await freePort();
    if (stopping) return await stopping;
    const home = NodePath.join(directory, "home");
    const backendOwnersDirectory = NodeFS.mkdtempSync(NodePath.join(directory, "backend-owners-"));
    const { resolveDevIdentity } = await import(
      NodeURL.pathToFileURL(NodePath.join(repo, "apps/desktop/scripts/electron-launcher.mjs"))
    );
    if (stopping) return await stopping;
    const appIdentity = resolveDevIdentity(repo);
    record = {
      ...owner,
      repo,
      branch,
      commit,
      dirty,
      startedAt: new Date().toISOString(),
      status: "starting",
      home,
      backendOwnersDirectory,
      electronUserData: NodePath.join(home, "userdata", "electron"),
      appBundleId: appIdentity.bundleId,
      ...(platform === "darwin"
        ? {
            appBundlePath: NodePath.join(
              repo,
              "apps/desktop/.electron-runtime",
              `${appIdentity.displayName}.app`,
            ),
          }
        : {}),
      debugPort,
      debugUrl: `http://127.0.0.1:${debugPort}`,
      logPath: NodePath.join(directory, "launch.log"),
      readinessPath: NodePath.join(directory, "renderer.json"),
    };
    NodeFS.rmSync(record.readinessPath, { force: true });
    const env = {
      ...process.env,
      T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(debugPort),
      T3CODE_COMMIT_HASH: commit,
      T3CODE_DEV_INSTANCE_NAME: `${NodePath.basename(repo)} ${commit.slice(0, 7)}`,
      T3CODE_DEV_BACKEND_OWNERS_DIR: backendOwnersDirectory,
      T3CODE_DEV_AUTO_PORT: "1",
    };
    env.PATH = `${NodePath.join(process.env.HOME, ".vite-plus", "bin")}:${env.PATH}`;
    delete env.ELECTRON_RUN_AS_NODE;
    // Parent dev sessions export an explicit backend port; let this runner allocate its own.
    delete env.T3CODE_PORT;
    // Build/bootstrap and runtime telemetry must not reuse a parent agent's production context.
    delete env.T3CODE_OTLP_HEADERS;
    delete env.T3CODE_OTLP_TRACES_URL;
    const logFd = NodeFS.openSync(record.logPath, "w", 0o600);
    runner = NodeChildProcess.spawn("pnpm", ["dev:desktop", "--home-dir", home], {
      cwd: repo,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    NodeFS.closeSync(logFd);
    record.runnerPid = runner.pid;
    save();
    log(
      `starting; log=${record.logPath}\ninstance=${file}\ndebug=${record.debugUrl}\nElectron profile=${record.electronUserData}`,
    );
    const exited = new Promise((resolve, reject) => {
      runner.once("exit", (code) => resolve(code ?? 1));
      runner.once("error", reject);
    });
    probe = NodeChildProcess.spawn(
      process.execPath,
      [
        NodePath.join(scriptDir, "ensure-renderer.mjs"),
        "--repo",
        repo,
        "--port",
        String(debugPort),
        "--receipt",
        record.readinessPath,
        "--timeout-seconds",
        process.env.LAUNCH_TRITONAI_RENDERER_TIMEOUT || "600",
      ],
      { cwd: repo, env, stdio: "inherit" },
    );
    probe.once("error", (error) => {
      console.error(error.message);
      void cleanup(1);
    });
    probe.once("exit", (code) => {
      if (stopping) return;
      if (code !== 0) {
        void cleanup(1);
        return;
      }
      record.status = "ready";
      record.renderer = readRecord(record.readinessPath);
      save();
      log(
        `ready; use status to retrieve this window and backend. Stop with launch.sh stop from this checkout.`,
      );
    });
    const exitCode = await exited;
    await cleanup(stopping ? 0 : exitCode);
  } catch (error) {
    await cleanup(1);
    throw error;
  } finally {
    process.removeListener("SIGTERM", signal);
    process.removeListener("SIGINT", signal);
    process.removeListener("SIGHUP", signal);
  }
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  await main().catch((error) => {
    console.error(`[launch-tritonai-dev] ${error.message}`);
    process.exitCode = 1;
  });
}
