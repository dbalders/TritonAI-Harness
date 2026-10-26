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
  const env = { PATH: bin, COLUMNS: "40", FIXTURE_ROOT: root, TRITONAI_HARNESS_REPO: root };
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
  const start = async (command = "start") => {
    const child = cp.spawn(process.execPath, [script, command], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const lines = readline.createInterface({ input: child.stdout });
    const first = await new Promise((resolve, reject) => {
      const deadline = AbortSignal.timeout(10_000);
      const expired = () => reject(new Error("Launcher did not report its owner"));
      deadline.addEventListener("abort", expired, { once: true });
      lines.once("line", (line) => {
        deadline.removeEventListener("abort", expired);
        resolve(JSON.parse(line));
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        deadline.removeEventListener("abort", expired);
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

// regression: d4dd8e9346 fix: address launcher and release workflow review findings
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

// regression: d4dd8e9346 fix: address launcher and release workflow review findings
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

for (const command of ["stop", "restart"]) {
}
