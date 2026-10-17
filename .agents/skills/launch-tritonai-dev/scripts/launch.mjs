import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";

const root = NodeFS.realpathSync(NodeURL.fileURLToPath(new URL("../../../../", import.meta.url)));
if (
  process.env.TRITONAI_HARNESS_REPO &&
  NodeFS.realpathSync(process.env.TRITONAI_HARNESS_REPO) !== root
)
  throw new Error(
    "Selected checkout differs from this launcher. Use the installed launch.sh wrapper.",
  );
if (!NodeFS.existsSync(NodePath.join(root, "apps/desktop/src/app/DesktopEnvironment.ts")))
  throw new Error("Not a Harness checkout.");
const home = NodePath.join(root, ".t3", "desktop");
const profileRoot = NodePath.join(home, "electron");
const ownerPath = NodePath.join(home, "launcher.json");
const debugPort =
  9400 +
  (Number.parseInt(NodeCrypto.createHash("sha256").update(root).digest("hex").slice(0, 4), 16) %
    1000);
const command = process.argv[2] ?? "start";
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readOwner = () => {
  try {
    return JSON.parse(NodeFS.readFileSync(ownerPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const status = () => {
  const owner = readOwner();
  let backend = null;
  try {
    const descriptor = ["dev", "userdata"]
      .map((directory) => NodePath.join(home, directory, "server-runtime.json"))
      .find((file) => NodeFS.existsSync(file));
    const state = descriptor ? JSON.parse(NodeFS.readFileSync(descriptor, "utf8")) : {};
    backend = { pid: state.pid, origin: state.origin, port: state.port };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    root,
    home,
    profileRoot,
    debuggingUrl: `http://127.0.0.1:${debugPort}`,
    launcherPid: owner?.pid ?? null,
    running: isOwnedLauncher(owner),
    backend,
  };
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inspectProcess = (pid, command, args, allowNoMatch = false) => {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  if (!result.error && result.status === 1 && allowNoMatch) return "";
  if (result.error || result.status !== 0) {
    if (!alive(pid)) return "";
    throw new Error(`Cannot inspect process ${pid} with ${command}; refusing to manage it.`, {
      cause: result.error,
    });
  }
  return result.stdout;
};
const processDetails = (pid) => ({
  cwd: inspectProcess(pid, "lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1),
  args: inspectProcess(pid, "ps", ["-ww", "-p", String(pid), "-o", "command="]),
  group: inspectProcess(pid, "ps", ["-p", String(pid), "-o", "pgid="]).trim(),
});
const isOwnedLauncher = (owner) => {
  if (!owner || owner.root !== root || !alive(owner.pid)) return false;
  const details = processDetails(owner.pid);
  return (
    details.cwd === root &&
    details.args.includes("dev:desktop") &&
    details.args.includes(home) &&
    details.group === String(owner.pid)
  );
};
const isOwnedBackend = (backend) => {
  if (!backend || !alive(backend.pid) || !Number.isSafeInteger(backend.port)) return false;
  const details = processDetails(backend.pid);
  const portOwner = inspectProcess(
    backend.pid,
    "lsof",
    ["-nP", "-a", "-p", String(backend.pid), "-iTCP:" + backend.port, "-sTCP:LISTEN", "-t"],
    true,
  ).trim();
  return (
    details.cwd === root &&
    details.args.includes(NodePath.join(root, "apps/server/dist/bin.mjs")) &&
    details.args.includes("--bootstrap-fd") &&
    portOwner === String(backend.pid)
  );
};
const stop = async () => {
  const owner = readOwner();
  const backend = status().backend;
  if (owner && alive(owner.pid)) {
    if (!isOwnedLauncher(owner) && alive(owner.pid))
      throw new Error("Refusing to stop a process whose checkout or ownership changed.");
  }
  if (backend?.pid && alive(backend.pid) && !isOwnedBackend(backend))
    throw new Error("Refusing to stop a backend whose checkout or listening port changed.");
  if (owner && alive(owner.pid)) process.kill(-owner.pid, "SIGTERM");
  // Electron starts its backend in a detached process group. A terminal signal
  // can bypass app quit cleanup, so stop that exact sandbox backend as well.
  if (backend?.pid && alive(backend.pid) && isOwnedBackend(backend)) {
    process.kill(backend.pid, "SIGTERM");
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((!owner || !alive(owner.pid)) && (!backend?.pid || !alive(backend.pid))) return;
    await wait(100);
  }
  throw new Error("The owned desktop did not stop; its ownership record was retained.");
};
if (command === "--check-checkout") {
  console.log(JSON.stringify({ root, home, profileRoot, isolated: true }));
} else if (command === "status") console.log(JSON.stringify(status()));
else if (command === "stop") {
  await stop();
  console.log(JSON.stringify(status()));
} else if (command === "start" || command === "restart") {
  if (command === "restart") await stop();
  const current = status();
  if (current.running) {
    console.log(JSON.stringify(current));
    process.exit(0);
  }
  if (isOwnedBackend(current.backend))
    throw new Error(
      "A backend is still alive without an owned launcher. Stop it through this launcher first.",
    );
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    T3CODE_DEV_APP_DATA_DIR: profileRoot,
    T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(debugPort),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = NodeChildProcess.spawn("vp", ["run", "dev:desktop", "--home-dir", home], {
    cwd: root,
    env,
    detached: true,
    stdio: "inherit",
  });
  const owner = { pid: child.pid, root, home, profileRoot, debugPort };
  NodeFS.writeFileSync(ownerPath, JSON.stringify(owner) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(status()));
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (alive(child.pid)) process.kill(-child.pid, signal);
    });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    if (readOwner()?.pid === child.pid) NodeFS.unlinkSync(ownerPath);
    process.exitCode = code ?? 0;
  });
} else throw new Error("Use start, status, stop, restart, or --check-checkout.");
