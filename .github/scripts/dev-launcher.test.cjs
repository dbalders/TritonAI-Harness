const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { promisify } = require("node:util");
const test = require("node:test");

const source = path.resolve(
  __dirname,
  "../../.agents/skills/launch-tritonai-dev/scripts/launch.mjs",
);
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
function fixture(t, { lsof = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-launcher-")));
  const script = path.join(root, ".agents/skills/launch-tritonai-dev/scripts/launch.mjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(source, script);
  fs.mkdirSync(path.join(root, "apps/desktop/src/app"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps/desktop/src/app/DesktopEnvironment.ts"), "");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync("/bin/ps", path.join(bin, "ps"));
  if (lsof)
    fs.writeFileSync(
      path.join(bin, "lsof"),
      '#!/bin/sh\nif [ "$1" = "-nP" ]; then [ -n "$FIXTURE_LISTENING_PID" ] || exit 1; printf "%s\\n" "$FIXTURE_LISTENING_PID"; exit; fi\nprintf "n%s\\n" "$FIXTURE_ROOT"\n',
      { mode: 0o755 },
    );
  fs.writeFileSync(
    path.join(bin, "vp"),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} -e 'setInterval(() => {}, 1000)' -- "$@"\n`,
    { mode: 0o755 },
  );
  const home = path.join(root, ".t3/desktop");
  fs.mkdirSync(home, { recursive: true });
  const env = { PATH: bin, FIXTURE_ROOT: root, TRITONAI_HARNESS_REPO: root };
  const children = [];
  t.after(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const run = (command, overrides = {}) =>
    cp.spawnSync(process.execPath, [script, command], {
      cwd: root,
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 15_000,
    });
  const owner = (pid) =>
    fs.writeFileSync(path.join(home, "launcher.json"), JSON.stringify({ pid, root, home }));
  const foreign = (...args) => {
    const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    children.push(child);
    owner(child.pid);
    return child;
  };
  const start = async () => {
    const child = cp.spawn(process.execPath, [script, "start"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const lines = readline.createInterface({ input: child.stdout });
    const first = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Launcher did not report its owner")),
        10_000,
      );
      lines.once("line", (line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Launcher exited ${code}`));
      });
    });
    lines.close();
    // The PID is captured from this test's launcher spawn receipt, never a name search.
    t.after(() => {
      try {
        process.kill(first.launcherPid, "SIGTERM");
      } catch {}
    });
    return first;
  };
  const runAsync = (command) =>
    promisify(cp.execFile)(process.execPath, [script, command], {
      cwd: root,
      env,
      timeout: 15_000,
    });
  return { root, home, run, runAsync, owner, foreign, start, env };
}

const posix = { skip: os.platform() === "win32" };
test("starts and stops only its owned group using lsof from PATH", posix, async (t) => {
  const f = fixture(t);
  const started = await f.start();
  assert.equal(started.running, true);
  const status = JSON.parse(f.run("status").stdout);
  assert.equal(status.launcherPid, started.launcherPid);
  assert.equal(status.running, true);
  assert.equal(JSON.parse(f.run("start").stdout).launcherPid, started.launcherPid);
  const stopped = f.run("stop");
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).running, false);
});

test("a reused PID is not running and is never stopped", posix, async (t) => {
  const f = fixture(t);
  const unrelated = f.foreign();
  assert.equal(JSON.parse(f.run("status").stdout).running, false);
  const refused = f.run("stop");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /ownership changed/);
  process.kill(unrelated.pid, 0);
  const started = await f.start();
  assert.notEqual(started.launcherPid, unrelated.pid);
  assert.equal(f.run("stop").status, 0);
  process.kill(unrelated.pid, 0);
});

test("missing lsof fails closed without signaling the recorded process", posix, (t) => {
  const f = fixture(t, { lsof: false });
  const unrelated = f.foreign();
  for (const command of ["status", "start", "stop", "restart"]) {
    const result = f.run(command);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot inspect.*lsof/);
    process.kill(unrelated.pid, 0);
  }
});

test("a different selected checkout cannot read or mutate this checkout", posix, (t) => {
  const f = fixture(t);
  for (const command of ["--check-checkout", "status", "start", "stop", "restart"]) {
    const result = f.run(command, { TRITONAI_HARNESS_REPO: os.tmpdir() });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Selected checkout differs/);
  }
  assert.equal(fs.existsSync(path.join(f.home, "launcher.json")), false);
});

test("an orphan owned backend prevents a duplicate start and can be stopped", posix, async (t) => {
  const f = fixture(t);
  const backend = f.foreign(path.join(f.root, "apps/server/dist/bin.mjs"), "--bootstrap-fd");
  f.env.FIXTURE_LISTENING_PID = String(backend.pid);
  fs.unlinkSync(path.join(f.home, "launcher.json"));
  fs.mkdirSync(path.join(f.home, "dev"));
  fs.writeFileSync(
    path.join(f.home, "dev/server-runtime.json"),
    JSON.stringify({ pid: backend.pid, port: 43001 }),
  );
  assert.match(f.run("start").stderr, /backend is still alive/);
  assert.equal(JSON.parse((await f.runAsync("stop")).stdout).running, false);
});

test("a stale backend PID does not block start or receive a signal", posix, async (t) => {
  const f = fixture(t);
  const unrelated = f.foreign();
  fs.unlinkSync(path.join(f.home, "launcher.json"));
  fs.mkdirSync(path.join(f.home, "dev"));
  fs.writeFileSync(
    path.join(f.home, "dev/server-runtime.json"),
    JSON.stringify({ pid: unrelated.pid, port: 43001 }),
  );
  const started = await f.start();
  assert.equal(started.running, true);
  process.kill(unrelated.pid, 0);
  // A stale descriptor is retained rather than using it to stop an unrelated PID.
  assert.notEqual(f.run("stop").status, 0);
  process.kill(unrelated.pid, 0);
});
