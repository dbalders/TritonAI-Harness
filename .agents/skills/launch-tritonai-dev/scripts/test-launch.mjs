import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import * as NodeUtil from "node:util";
import * as NodeTest from "node:test";
import { processBirth } from "./launch.mjs";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

async function fixture(t) {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dev-owner-test-"));
  NodeFS.writeFileSync(
    NodePath.join(repo, "package.json"),
    JSON.stringify({ name: "@t3tools/monorepo", scripts: { "dev:desktop": "unused" } }),
  );
  const dir = NodePath.join(repo, ".t3", "launch-tritonai-dev");
  NodeFS.mkdirSync(dir, { recursive: true });
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["-e", 'setInterval(() => {}, 1000); console.log("ready")'],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await NodeEvents.once(child.stdout, "data");
  t.after(() => {
    if (child.exitCode === null) child.kill();
    NodeFS.rmSync(repo, { recursive: true, force: true });
  });
  const record = {
    ownerPid: child.pid,
    ownerBirth: processBirth(child.pid),
    branch: "fixture",
    commit: "abcdef1234567",
  };
  return {
    child,
    write: (value) =>
      NodeFS.writeFileSync(NodePath.join(dir, "instance.json"), JSON.stringify(value)),
    record,
    stop: () =>
      execFile(process.execPath, [NodePath.join(import.meta.dirname, "launch.mjs"), "stop"], {
        env: { ...process.env, TRITONAI_HARNESS_REPO: repo },
      }),
  };
}

NodeTest.test(
  "stop terminates only the recorded owner and leaves another instance alive",
  async (t) => {
    const first = await fixture(t);
    const second = await fixture(t);
    first.write(first.record);
    second.write(second.record);
    await first.stop();
    NodeAssert.equal(first.child.signalCode, "SIGTERM");
    NodeAssert.equal(processBirth(second.child.pid), second.record.ownerBirth);
  },
);

NodeTest.test("stale process identity never signals a reused PID", async (t) => {
  const instance = await fixture(t);
  instance.write({ ...instance.record, ownerBirth: "a previous process at this PID" });
  await instance.stop();
  NodeAssert.equal(processBirth(instance.child.pid), instance.record.ownerBirth);
});

NodeTest.test("readiness watchdog terminates a stalled connection", async (t) => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dev-probe-test-"));
  t.after(() => NodeFS.rmSync(repo, { recursive: true, force: true }));
  const entryDir = NodePath.join(
    repo,
    "node_modules/.pnpm/playwright-core@1.0.0/node_modules/playwright-core",
  );
  NodeFS.mkdirSync(entryDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(entryDir, "index.mjs"),
    "export const chromium = { connectOverCDP: () => { setInterval(() => {}, 1000); return new Promise(() => {}); } };",
  );
  await NodeAssert.rejects(
    execFile(
      process.execPath,
      [
        NodePath.join(import.meta.dirname, "ensure-renderer.mjs"),
        "--repo",
        repo,
        "--port",
        "12345",
        "--timeout-seconds",
        "0.1",
      ],
      { timeout: 5000 },
    ),
    (error) => {
      NodeAssert.equal(error.code, 1);
      NodeAssert.match(error.stderr, /readiness deadline exceeded/);
      return true;
    },
  );
});

NodeTest.test(
  "separate supervisors retain independent homes and reuse the same checkout",
  async (t) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "dev-launch-test-"));
    const launcher = NodePath.join(import.meta.dirname, "launch.mjs");
    const instances = [];
    t.after(async () => {
      for (const instance of instances) {
        await instance.command("stop").catch(() => {});
      }
      NodeFS.rmSync(root, { recursive: true, force: true });
    });
    const create = async (name) => {
      const repo = NodePath.join(root, name);
      NodeFS.mkdirSync(NodePath.join(repo, "apps/desktop/scripts"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(repo, "apps/desktop/scripts/electron-launcher.mjs"),
        'export const resolveDevIdentity = (root) => ({ displayName: root.split("/").pop(), bundleId: root.split("/").pop() });',
      );
      NodeFS.writeFileSync(
        NodePath.join(repo, "package.json"),
        JSON.stringify({
          name: "@t3tools/monorepo",
          scripts: { "dev:desktop": "node runner.cjs" },
        }),
      );
      NodeFS.writeFileSync(
        NodePath.join(repo, "runner.cjs"),
        'require("node:fs").writeFileSync("observed.json", JSON.stringify({port: process.env.T3CODE_PORT ?? null, args: process.argv.slice(2)})); setInterval(() => {}, 1000);',
      );
      const mock = NodePath.join(
        repo,
        "node_modules/.pnpm/playwright-core@1.0.0/node_modules/playwright-core",
      );
      NodeFS.mkdirSync(mock, { recursive: true });
      // The supervisor's lifecycle is real; renderer readiness is a controlled test double.
      NodeFS.writeFileSync(
        NodePath.join(mock, "index.mjs"),
        `
      import { existsSync } from "node:fs";
      export const chromium = { async connectOverCDP() {
        if (!existsSync(${JSON.stringify(NodePath.join(repo, "observed.json"))})) throw Error("runner not ready");
        let calls = 0;
        const page = { url: () => "t3code-dev://app/", evaluate: async () => ++calls === 1 ? "mounted" : ({storage:"ok", authenticated:true, backend:"http://127.0.0.1:12345"}) };
        return { contexts: () => [{ pages: () => [page] }], close: async () => {} };
      } };
    `,
      );
      await execFile("git", ["init", "-q", repo]);
      await execFile("git", [
        "-C",
        repo,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      ]);
      const env = {
        ...process.env,
        TRITONAI_HARNESS_REPO: repo,
        T3CODE_PORT: "12345",
        LAUNCH_TRITONAI_RENDERER_TIMEOUT: "20",
      };
      const command = (action) =>
        execFile(process.execPath, [launcher, action], { env, timeout: 20000 });
      const read = () =>
        JSON.parse(
          NodeFS.readFileSync(NodePath.join(repo, ".t3/launch-tritonai-dev/instance.json"), "utf8"),
        );
      const instance = { repo, command, read };
      instances.push(instance);
      const child = NodeChildProcess.spawn(process.execPath, [launcher], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(Error(`fixture launch timed out: ${output}`)), 25000);
        child.stdout.on("data", (data) => {
          output += data;
          if (output.includes("ready; use status")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(Error(`fixture exited ${code}: ${output}`));
        });
      });
      return instance;
    };
    const first = await create("first");
    const second = await create("second");
    const firstRecord = first.read();
    const secondRecord = second.read();
    NodeAssert.notEqual(firstRecord.home, secondRecord.home);
    NodeAssert.notEqual(firstRecord.ownerPid, secondRecord.ownerPid);
    NodeAssert.notEqual(firstRecord.debugPort, secondRecord.debugPort);
    const observed = JSON.parse(
      NodeFS.readFileSync(NodePath.join(first.repo, "observed.json"), "utf8"),
    );
    NodeAssert.equal(observed.port, null);
    NodeAssert.deepEqual(observed.args, ["--home-dir", firstRecord.home]);
    await first.command("start");
    NodeAssert.equal(first.read().ownerPid, firstRecord.ownerPid);
    await first.command("stop");
    NodeAssert.equal(first.read().status, "stopped");
    NodeAssert.equal(processBirth(secondRecord.ownerPid), secondRecord.ownerBirth);
    NodeAssert.equal(second.read().status, "ready");
  },
);
