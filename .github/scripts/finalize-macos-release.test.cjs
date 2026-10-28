"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const { test } = require("node:test");
const { createRequire } = require("node:module");
const { initSync, parse } = createRequire(
  path.resolve(__dirname, "../../packages/shared/package.json"),
)("es-module-lexer");
initSync();
const parseImports = (source) => parse(source)[0];
const { failureExitCode } = require("./finalize-macos-release.cjs");
const {
  macReleaseIdentity,
  findKeptStage,
  verifyPluginPayload: verifyPluginPayloadWithImports,
  isolatedBootEnvironment,
  withMountedDmg,
  verifyPackagedBoot,
  finalizeMacRelease,
  trackBootProcesses,
} = require("./finalize-macos-release.cjs");
const verifyPluginPayload = (...args) => verifyPluginPayloadWithImports(...args, parseImports);

function fixture(t, version = "0.3.4") {
  const { productName } = macReleaseIdentity(version);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "local-release-mac-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stageRoot = path.join(root, "stage");
  const stageApp = path.join(stageRoot, "t3code-desktop-mac-stage-fixture", "app");
  const app = path.join(root, `${productName}.app`);
  const release = path.join(root, "custom-output");
  fs.mkdirSync(stageApp, { recursive: true });
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.mkdirSync(release);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.10.0" }),
  );
  fs.writeFileSync(path.join(app, "Contents", "Resources", "app.asar"), "fixture-archive");
  fs.writeFileSync(
    path.join(stageApp, "package.json"),
    JSON.stringify({
      version,
      t3codeCommitHash: "b".repeat(12),
      build: { productName, mac: { target: ["zip"] } },
    }),
  );
  const bytes = Buffer.from("plugin implementation");
  const file = {
    path: "index.js",
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };
  const digest = crypto
    .createHash("sha256")
    .update(file.path)
    .update("\0")
    .update(String(file.size))
    .update("\0")
    .update(bytes)
    .update("\0")
    .digest("hex");
  const composition = {
    version: 1,
    kind: "tritonai-harness-plugin-composition",
    source: {
      repository: "https://github.com/dbalders/TritonAI-Plugins.git",
      ref: "refs/tags/v0.1.0",
      commit: "a".repeat(40),
    },
    packages: [
      { id: "github", name: "@tritonai/plugin-github", version: "0.1.0", digest, files: [file] },
    ],
  };
  const pluginsPath = "apps/server/dist/production-integrations";
  const entries = {
    "package.json": Buffer.from(JSON.stringify({ version })),
    "apps/server/dist/bin.mjs": Buffer.from(
      'export const plugins = "github production-integrations tritonai-harness-plugin-composition";',
    ),
    [`${pluginsPath}/packages/github/index.js`]: bytes,
  };
  const archivePaths = () => {
    const names = new Set(Object.keys(entries));
    for (const name of Object.keys(entries)) {
      for (
        let parent = path.posix.dirname(name);
        parent !== ".";
        parent = path.posix.dirname(parent)
      )
        names.add(parent);
    }
    return [...names];
  };
  const asar = {
    extractFile: (_archive, entry) => {
      entry = entry.replaceAll("\\", "/");
      assert(entries[entry], `Missing entry ${entry}`);
      return entries[entry];
    },
    listPackage: () => archivePaths().map((entry) => `/${entry}`),
    statFile: (_archive, entry) => {
      entry = entry.replaceAll("\\", "/");
      assert(archivePaths().includes(entry), `Missing entry ${entry}`);
      return entries[entry] ? { size: entries[entry].length } : { files: {} };
    },
  };
  const snapshot = path.join(path.dirname(stageApp), "plugin-composition-input");
  fs.mkdirSync(snapshot);
  fs.writeFileSync(path.join(snapshot, "manifest.json"), JSON.stringify(composition));
  fs.writeFileSync(
    path.join(release, ".tritonai-plugin-composition-mac-arm64.json.input"),
    JSON.stringify(composition),
  );
  const key = path.join(root, "AuthKey.p8");
  fs.writeFileSync(key, "test-key");
  const env = {
    DEVELOPER_ID_APPLICATION: "Developer ID Application: Fixture (TEAM)",
    APPLE_API_KEY: key,
    APPLE_API_KEY_ID: "KEY",
    APPLE_API_ISSUER: "ISSUER",
  };
  return {
    version,
    productName,
    root,
    stageRoot,
    stageApp,
    app,
    release,
    composition,
    entries,
    asar,
    env,
  };
}

test("selects only the unique exact candidate stage with matching version", (t) => {
  const f = fixture(t);
  assert.equal(findKeptStage(f.stageRoot, "0.3.4"), f.stageApp);
  assert.throws(() => findKeptStage(f.stageRoot, "0.3.5"), /version\/product/);
  fs.mkdirSync(path.join(f.stageRoot, "t3code-desktop-mac-stage-old"));
  assert.throws(() => findKeptStage(f.stageRoot, "0.3.4"), /found 2/);
});

test("checks ASAR plugin bytes against the external proof without requiring an embedded manifest", (t) => {
  const f = fixture(t);
  assert.equal(verifyPluginPayload(f.app, f.composition, f.asar, "0.3.4").fileCount, 1);
  const pluginFile = "apps/server/dist/production-integrations/packages/github/index.js";
  f.entries[pluginFile] = Buffer.from("corrupted implementation");
  assert.throws(() => verifyPluginPayload(f.app, f.composition, f.asar, "0.3.4"), /file differs/);
});

test("verifies plugin markers through reachable lazy and re-exported backend chunks", (t) => {
  const f = fixture(t);
  const entry = "apps/server/dist/bin.mjs";
  const cli = "apps/server/dist/binCli-candidate.mjs";
  const builtins = "apps/server/dist/production-builtins.mjs";
  const markers = f.entries[entry];
  f.entries[entry] = Buffer.from(`/** @import {Options} from "../index.js" */
const example = 'import("./missing.mjs")'; const cli = await import("./binCli-candidate.mjs"); cli.run();`);
  f.entries[cli] = Buffer.from('export { run } from "./production-builtins.mjs";');
  f.entries[builtins] = Buffer.from(`import "./binCli-candidate.mjs";\n${markers}`);
  assert.equal(verifyPluginPayload(f.app, f.composition, f.asar, "0.3.4").fileCount, 1);
  delete f.entries[builtins];
  assert.throws(
    () => verifyPluginPayload(f.app, f.composition, f.asar, "0.3.4"),
    /backend module.*production-builtins/,
  );
});

test("does not accept plugin markers or selected IDs from unreferenced backend chunks", (t) => {
  const f = fixture(t);
  const entry = "apps/server/dist/bin.mjs";
  f.entries["apps/server/dist/decoy.mjs"] = f.entries[entry];
  f.entries[entry] = Buffer.from("export {};");
  assert.throws(
    () => verifyPluginPayload(f.app, f.composition, f.asar, "0.3.4"),
    /missing plugin marker/,
  );
  f.entries[entry] = Buffer.from(
    'export const plugins = "production-integrations tritonai-harness-plugin-composition";',
  );
  assert.throws(
    () => verifyPluginPayload(f.app, f.composition, f.asar, "0.3.4"),
    /missing selected plugin: github/,
  );
});

test("rejects backend imports that escape the packaged server directory", (t) => {
  const f = fixture(t);
  f.entries["apps/server/dist/bin.mjs"] = Buffer.from('export { run } from "../unrelated.mjs";');
  f.entries["apps/server/unrelated.mjs"] = Buffer.from(
    'export const plugins = "github production-integrations tritonai-harness-plugin-composition";',
  );
  assert.throws(
    () => verifyPluginPayload(f.app, f.composition, f.asar, "0.3.4"),
    /outside the packaged server/,
  );
});

test("rejects unlisted packaged plugin files and different manifests", (t) => {
  const f = fixture(t);
  f.entries["apps/server/dist/production-integrations/packages/github/unlisted.js"] =
    Buffer.from("extra");
  assert.throws(
    () => verifyPluginPayload(f.app, f.composition, f.asar, "0.3.4"),
    /Unexpected packaged plugin entry/,
  );
  delete f.entries["apps/server/dist/production-integrations/packages/github/unlisted.js"];
  f.entries["apps/server/dist/production-integrations/manifest.json"] = Buffer.from(
    JSON.stringify(f.composition),
  );
  assert.equal(verifyPluginPayload(f.app, f.composition, f.asar, "0.3.4").fileCount, 1);
  f.entries["apps/server/dist/production-integrations/manifest.json"] = Buffer.from("{}");
  assert.throws(
    () => verifyPluginPayload(f.app, f.composition, f.asar, "0.3.4"),
    /manifest differs/,
  );
});

test("boot environment isolates all user state and excludes ambient credentials", () => {
  const environment = isolatedBootEnvironment("/tmp/candidate-home", {
    HOME: "/Users/live",
    PATH: "/usr/bin",
    OPENAI_API_KEY: "secret",
    GH_TOKEN: "secret",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--require unsafe",
    TRITONAI_HOME: "/Users/live/.tritonai-harness",
  });
  assert.equal(environment.HOME, "/tmp/candidate-home");
  assert.equal(environment.TRITONAI_HOME, path.join("/tmp/candidate-home", "harness-state"));
  assert.equal(environment.PATH, "/usr/bin");
  for (const key of ["OPENAI_API_KEY", "GH_TOKEN", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"])
    assert.equal(environment[key], undefined);
});

test("retains an attached mountpoint on failed detach", async (t) => {
  const f = fixture(t);
  let mount;
  await assert.rejects(
    withMountedDmg(
      "fixture.dmg",
      f.stageRoot,
      (_command, args) => {
        if (args[0] === "attach") mount = args.at(-1);
        if (args[0] === "detach") throw new Error("detach failed");
      },
      () => undefined,
    ),
    /detach failed/,
  );
  assert(fs.existsSync(mount), "mounted volume must not be recursively removed");
});

function bootMocks(
  f,
  {
    version = "0.3.4",
    rendererUrl = "t3code://app/",
    unsafeUserData = false,
    hungEvaluation = false,
    hungClose = false,
    stuckBackend = false,
    reusedBackend = false,
    forkDuringCleanup = false,
    closeSignal,
  } = {},
) {
  let launchOptions;
  let closed = false;
  const child = Object.assign(new EventEmitter(), { pid: 100, exitCode: null, signalCode: null });
  const signals = new EventEmitter();
  const evaluationReceipt = Promise.withResolvers();
  const killedGroups = [];
  const signaledGroups = [];
  let processes = [
    { pid: 100, ppid: 50, pgid: 100, status: "S", started: "Wed Sep 9 16:00:00 2026" },
    { pid: 200, ppid: 100, pgid: 200, status: "S", started: "Wed Sep 9 16:00:01 2026" },
    { pid: 201, ppid: 200, pgid: 200, status: "S", started: "Wed Sep 9 16:00:02 2026" },
    { pid: 300, ppid: 100, pgid: 100, status: "S", started: "Wed Sep 9 16:00:02 2026" },
    { pid: 900, ppid: 50, pgid: 900, status: "S", started: "Wed Sep 9 16:00:00 2026" },
  ];
  const page = { url: () => rendererUrl, evaluate: async () => true };
  const application = {
    process: () => child,
    evaluate: async (_callback, argument) => {
      evaluationReceipt.resolve();
      return hungEvaluation
        ? new Promise(() => {})
        : argument
          ? true
          : {
              version,
              packaged: true,
              userData: unsafeUserData
                ? "/Users/live/Library/Application Support/tritonai-harness"
                : path.join(
                    launchOptions.env.HOME,
                    "Library",
                    "Application Support",
                    "tritonai-harness",
                  ),
              windows: [{ visible: true, rendererPid: 300, url: page.url() }],
            };
    },
    windows: () => [page],
    close: async () => {
      closed = true;
      if (closeSignal) signals.emit(closeSignal);
      if (reusedBackend)
        processes = processes
          .filter((p) => p.pid !== 201)
          .map((p) => (p.pid === 200 ? { ...p, ppid: 1, started: "Wed Sep 9 16:05:00 2026" } : p));
      if (hungClose) return new Promise(() => {});
      processes = processes.filter((p) => p.pid === 900);
      child.exitCode = 0;
      child.emit("exit", 0);
    },
  };
  return {
    evaluationStarted: evaluationReceipt.promise,
    electron: {
      launch: async (options) => {
        launchOptions = options;
        return application;
      },
    },
    runCommand: (command, args) => {
      if (command.endsWith("ditto")) fs.cpSync(args.at(-2), args.at(-1), { recursive: true });
      return { stdout: command.endsWith("lsof") ? "p200\n" : "100\n" };
    },
    wait: async () => {},
    selectPort: async () => 43123,
    assertAlive: () => {},
    fetchResponse: async (url) => {
      assert.equal(url, "http://127.0.0.1:43123/.well-known/t3/environment");
      return { ok: true };
    },
    readProcessSnapshot: () => structuredClone(processes),
    killGroup: (pid, signal) => {
      assert([100, 200, 400, 500].includes(pid), "must never signal an unrelated process group");
      signaledGroups.push([pid, signal]);
      if (signal === "SIGSTOP") {
        // Simulate a detached fork after the snapshot, just before its parent
        // receives SIGSTOP. The new group must be found on the next pass.
        if (forkDuringCleanup && [200, 400].includes(pid)) {
          const next = pid === 200 ? 400 : 500;
          if (!processes.some((p) => p.pid === next))
            processes.push({
              pid: next,
              ppid: pid,
              pgid: next,
              status: "S",
              started: `Wed Sep 9 16:00:0${next / 100} 2026`,
            });
        }
        processes = processes.map((p) => (p.pgid === pid ? { ...p, status: "T" } : p));
        return;
      }
      if (signal === "SIGCONT") {
        processes = processes.map((p) => (p.pgid === pid ? { ...p, status: "S" } : p));
        return;
      }
      assert.equal(signal, "SIGKILL");
      assert(
        processes
          .filter((p) => p.pid !== 900 && p.pid !== (reusedBackend ? 200 : -1))
          .every((p) => p.status.startsWith("T")),
        "must freeze every owned process before the first kill",
      );
      killedGroups.push(pid);
      if (pid === 200 && stuckBackend) return;
      processes = processes.filter((p) => p.pgid !== pid);
      if (pid === child.pid) {
        child.signalCode = "SIGKILL";
        child.emit("exit", null, "SIGKILL");
      }
    },
    signals,
    getState: () => ({
      launchOptions,
      closed,
      child,
      signals,
      killedGroups,
      signaledGroups,
      processes,
    }),
  };
}

for (const [version, rendererUrl] of [
  ["0.3.4-nightly.20260915.42", "t3code://app/"],
  ["0.3.4", "tritonai-harness-nightly://app/"],
]) {
  test(`boot gate rejects the other channel protocol for ${version}`, async (t) => {
    const f = fixture(t, version);
    const mock = bootMocks(f, { version, rendererUrl });
    await assert.rejects(
      verifyPackagedBoot({
        appPath: f.app,
        stageRoot: f.stageRoot,
        version,
        env: f.env,
        ...mock,
        wait: async (ms) => {
          assert.equal(ms, 500, "must keep polling instead of accepting the renderer");
          throw new Error("stop rejected renderer polling");
        },
        fetchResponse: async () => {
          assert.fail("wrong-channel renderer must not reach backend verification");
        },
      }),
      /stop rejected renderer polling/,
    );
  });
}

test("forced cleanup repeatedly freezes detached descendants born between discovery and signaling", async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f, { hungEvaluation: true, hungClose: true, forkDuringCleanup: true });
  await assert.rejects(
    verifyPackagedBoot({
      appPath: f.app,
      stageRoot: f.stageRoot,
      version: "0.3.4",
      env: f.env,
      ...mock,
      operationTimeoutMs: 10,
      closeTimeoutMs: 10,
    }),
    /main-process evaluation timed out/,
  );
  assert.deepEqual(mock.getState().killedGroups, [500, 400, 200, 100]);
  assert.deepEqual(
    mock.getState().processes.map((p) => p.pid),
    [900],
  );
  assert(!fs.existsSync(mock.getState().launchOptions.env.HOME));
});

test("cleanup refuses to kill when owned processes cannot be frozen and resumes groups it paused", async (t) => {
  const f = fixture(t);
  const child = { pid: 100, exitCode: null, signalCode: null };
  const processes = [
    { pid: 100, ppid: 50, pgid: 100, status: "S", started: "Wed Sep 9 16:00:00 2026" },
  ];
  const signals = [];
  const tracker = trackBootProcesses(
    child,
    () => structuredClone(processes),
    (pid, signal) => signals.push([pid, signal]),
    path.join(f.root, "unfrozen.json"),
    10,
  );
  assert.throws(() => tracker.forceStop(), /Could not freeze/);
  assert(signals.some(([, signal]) => signal === "SIGSTOP"));
  assert.equal(signals.at(-1)[1], "SIGCONT");
  assert(!signals.some(([, signal]) => signal === "SIGKILL"));
  assert.equal(tracker.stopped, false);
});

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  const assertCancellation = (error) => {
    assert.equal(error.code, "EINTR");
    assert.equal(error.signal, signal);
    assert.equal(error.exitCode, exitCode);
    assert.equal(failureExitCode(error), exitCode);
    return true;
  };

  test(`${signal} during cleanup cancels a pending successful boot result`, async (t) => {
    const f = fixture(t);
    const mock = bootMocks(f, { hungClose: true, closeSignal: signal });
    await assert.rejects(
      verifyPackagedBoot({
        appPath: f.app,
        stageRoot: f.stageRoot,
        version: "0.3.4",
        env: f.env,
        ...mock,
        operationTimeoutMs: 20,
        closeTimeoutMs: 10,
      }),
      assertCancellation,
    );
    assert.deepEqual(mock.getState().killedGroups, [200, 100]);
    assert(!fs.existsSync(mock.getState().launchOptions.env.HOME));
    assert.equal(mock.signals.listenerCount("SIGINT"), 0);
    assert.equal(mock.signals.listenerCount("SIGTERM"), 0);
  });
}

test("forced cleanup rejects reused backend PIDs and preserves unrelated process groups", async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f, { hungEvaluation: true, hungClose: true, reusedBackend: true });
  await assert.rejects(
    verifyPackagedBoot({
      appPath: f.app,
      stageRoot: f.stageRoot,
      version: "0.3.4",
      env: f.env,
      ...mock,
      operationTimeoutMs: 10,
      closeTimeoutMs: 10,
    }),
    /main-process evaluation timed out/,
  );
  assert.deepEqual(mock.getState().killedGroups, [100]);
  assert.deepEqual(
    mock.getState().processes.map((p) => p.pid),
    [200, 900],
  );
});

test("boot gate fails closed if Electron resolves the live user-data directory", async (t) => {
  const f = fixture(t);
  const mock = bootMocks(f, { unsafeUserData: true });
  await assert.rejects(
    verifyPackagedBoot({
      appPath: f.app,
      stageRoot: f.stageRoot,
      version: "0.3.4",
      env: f.env,
      ...mock,
    }),
    /isolated candidate/,
  );
  assert.equal(mock.getState().closed, true);
});

function packagingMocks(f, status = "Accepted") {
  const calls = [];
  const signedApp = path.join(f.stageApp, "dist", "mac-arm64", `${f.productName}.app`);
  const command = (program, args, options = {}) => {
    calls.push({ program, args, options });
    if (program === "git") return { stdout: "b".repeat(40) };
    if (program === "codesign" && args[0] === "--display")
      return { stderr: "Authority=Developer ID Application: Fixture (TEAM)\n" };
    if (program === "vp") {
      fs.cpSync(f.app, signedApp, { recursive: true });
      fs.writeFileSync(
        path.join(f.stageApp, "dist", `TritonAI-Harness-${f.version}-arm64.zip`),
        "zip",
      );
      fs.writeFileSync(
        path.join(f.stageApp, "dist", `TritonAI-Harness-${f.version}-arm64.zip.blockmap`),
        "zip-blockmap",
      );
    }
    if (program.endsWith("ditto")) {
      assert.notEqual(args[0], "-c", "the signed app must not be archived again");
      const target =
        args[0] === "-x" ? path.join(args.at(-1), `${f.productName}.app`) : args.at(-1);
      fs.cpSync(args[0] === "-x" ? signedApp : args.at(-2), target, { recursive: true });
    }
    if (program === "hdiutil") {
      if (args[0] === "create" || args[0] === "convert") fs.writeFileSync(args.at(-1), "dmg");
      if (args[0] === "attach" && args.includes("-readonly"))
        fs.cpSync(signedApp, path.join(args.at(-1), `${f.productName}.app`), { recursive: true });
    }
    if (program === "xcrun" && args[0] === "notarytool")
      return { stdout: JSON.stringify({ status, id: "notary-job" }) };
    if (program === "xcrun" && args[1] === "staple") {
      if (fs.statSync(args[2]).isDirectory())
        fs.writeFileSync(path.join(args[2], "Contents", "CodeResources"), "ticket");
      else fs.appendFileSync(args[2], "-stapled");
    }
    if (program === process.execPath && args.includes("--artifact")) {
      const dmg = args[args.indexOf("--artifact") + 1];
      const bytes = fs.readFileSync(dmg);
      fs.writeFileSync(
        path.join(f.release, "tritonai-plugin-composition-mac-arm64.json"),
        JSON.stringify({
          ...f.composition,
          artifacts: [
            {
              fileName: path.basename(dmg),
              size: bytes.length,
              sha512: crypto.createHash("sha512").update(bytes).digest("base64"),
            },
          ],
        }),
      );
    }
    return { stdout: "" };
  };
  return {
    calls,
    command,
    tools: {
      parseImports,
      asar: f.asar,
      buildBlockMap: async (input, format, output) => {
        assert.equal(format, "gzip");
        assert.match(fs.readFileSync(input, "utf8"), /-stapled$/);
        calls.push({ program: "buildBlockMap", args: [input] });
        fs.writeFileSync(output, "final-blockmap");
      },
      archive: async (format, output, appDir, options) => {
        assert.equal(format, "zip");
        assert.deepEqual(options, {
          compression: "normal",
          withoutDir: false,
          preserveSymlinks: true,
        });
        assert(
          fs.existsSync(path.join(appDir, "Contents", "CodeResources")),
          "the updater ZIP must be built from the stapled app",
        );
        calls.push({ program: "archive", args: [output, appDir] });
        fs.writeFileSync(output, "zip-from-app-stapled");
      },
    },
  };
}

test("full finalization binds metadata after stapling, verifies payload and boot, and uses explicit output", async (t) => {
  const f = fixture(t);
  const mock = packagingMocks(f);
  let bootVerified = false;
  const report = await finalizeMacRelease({
    harnessRoot: f.root,
    stageRoot: f.stageRoot,
    version: "0.3.4",
    outputDir: f.release,
    env: f.env,
    platform: "darwin",
    runCommand: mock.command,
    packagingTools: mock.tools,
    verifyBoot: async ({ appPath }) => {
      assert(fs.existsSync(path.join(appPath, "Contents", "Resources", "app.asar")));
      bootVerified = true;
      return { healthyForMs: 5000 };
    },
  });
  assert(bootVerified);
  assert.equal(report.notarization.status, "Accepted");
  assert(fs.existsSync(path.join(f.release, "harness-mac-verification.json")));
  assert.match(
    fs.readFileSync(path.join(f.release, "latest-mac.yml"), "utf8"),
    new RegExp(`size: ${"dmg-stapled".length}`),
  );
  const signing = mock.calls.find((call) => call.program === "vp");
  assert.equal(signing.options.env.CSC_NAME, "Fixture (TEAM)");
  assert.equal(signing.options.env.npm_config_user_agent, "pnpm/11.10.0");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.stageApp, "package.json"))).build.mac.sign,
    path.join(f.root, "scripts/sign-macos.ts"),
  );
  assert.equal(signing.options.env.APPLE_API_KEY, undefined);
  assert.equal(mock.calls.filter((call) => call.program === "vp").length, 1);
  const validation = mock.calls.findIndex(
    (call) => call.args[0] === "scripts/verify-macos-desktop-package.ts",
  );
  const notarization = mock.calls.findIndex(
    (call) => call.program === "xcrun" && call.args[0] === "notarytool",
  );
  assert(validation > 0 && validation < notarization);
  const finalizer = mock.calls.find((call) => call.args.includes("--artifact"));
  assert.equal(finalizer.args.at(-1), f.release);
  assert.equal(report.appNotarization.status, "Accepted");
  const appNotarization = mock.calls.findIndex(
    (call) =>
      call.program === "xcrun" &&
      call.args[0] === "notarytool" &&
      call.args[2] === path.join(f.stageApp, "dist", `TritonAI-Harness-${f.version}-arm64.zip`),
  );
  const appStaple = mock.calls.findIndex(
    (call) =>
      call.program === "xcrun" && call.args[1] === "staple" && call.args[2].endsWith(".app"),
  );
  const zipBuild = mock.calls.findIndex((call) => call.program === "archive");
  const dmgCreate = mock.calls.findIndex(
    (call) => call.program === "hdiutil" && call.args[0] === "create",
  );
  assert(
    validation < appNotarization &&
      appNotarization < appStaple &&
      appStaple < zipBuild &&
      zipBuild < dmgCreate,
    "the app must be notarized and stapled before the updater ZIP and DMG are built from it",
  );
  assert(
    mock.calls.some((call) => call.program === "buildBlockMap" && call.args[0].endsWith(".zip")),
    "the rebuilt ZIP needs a fresh blockmap",
  );
  const validations = mock.calls
    .filter((call) => call.program === "xcrun" && call.args[1] === "validate")
    .map((call) => call.args[2]);
  assert(
    validations.some((target) => target.includes("verify-zip-")),
    "the app inside the final ZIP must carry the staple",
  );
  assert(
    validations.filter((target) => target.endsWith(".app")).length >= 3,
    "signed, DMG, and ZIP apps must all validate",
  );
  assert.match(
    fs.readFileSync(path.join(f.release, "latest-mac.yml"), "utf8"),
    new RegExp(`size: ${"zip-from-app-stapled".length}`),
  );
});

test("finalization recovers a lost stapling connection on the accepted app and DMG without re-uploading", async (t) => {
  const f = fixture(t);
  const mock = packagingMocks(f);
  const attempts = new Map();
  const waits = [];
  const report = await finalizeMacRelease({
    harnessRoot: f.root,
    stageRoot: f.stageRoot,
    version: f.version,
    outputDir: f.release,
    env: f.env,
    platform: "darwin",
    packagingTools: mock.tools,
    wait: async (ms) => waits.push(ms),
    verifyBoot: async () => ({ healthyForMs: 5000 }),
    runCommand: (program, args, options) => {
      if (program === "xcrun" && args[1] === "staple") {
        const attempt = (attempts.get(args[2]) || 0) + 1;
        attempts.set(args[2], attempt);
        if (attempt === 1)
          throw Object.assign(new Error("Staple failed (exit 68)."), {
            result: {
              status: 68,
              stderr: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
            },
          });
        const receipt = path.join(
          f.stageRoot,
          args[2].endsWith(".app") ? "notarization-app.json" : "notarization-dmg.json",
        );
        assert.equal(JSON.parse(fs.readFileSync(receipt, "utf8")).status, "Accepted");
      }
      return mock.command(program, args, options);
    },
  });
  assert.deepEqual([...attempts.values()], [2, 2]);
  assert.deepEqual(waits, [10000, 10000]);
  assert.equal(
    mock.calls.filter((call) => call.program === "vp").length,
    1,
    "must not re-sign the app",
  );
  assert.equal(
    mock.calls.filter((call) => call.program === "xcrun" && call.args[0] === "notarytool").length,
    2,
    "must submit each artifact only once",
  );
  assert.deepEqual(report.appNotarization, { status: "Accepted", id: "notary-job" });
  assert.deepEqual(report.notarization, { status: "Accepted", id: "notary-job" });
});

test("successful staple recovery still requires strict ticket validation before packaging", async (t) => {
  const f = fixture(t),
    mock = packagingMocks(f);
  let attempts = 0,
    validations = 0;
  await assert.rejects(
    finalizeMacRelease({
      harnessRoot: f.root,
      stageRoot: f.stageRoot,
      version: f.version,
      outputDir: f.release,
      env: f.env,
      platform: "darwin",
      packagingTools: mock.tools,
      wait: async () => {},
      runCommand: (program, args, options) => {
        if (program === "xcrun" && args[1] === "staple" && ++attempts === 1)
          throw Object.assign(new Error("Staple failed"), {
            result: {
              status: 68,
              stderr:
                'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\n',
            },
          });
        if (program === "xcrun" && args[1] === "validate") {
          validations++;
          throw new Error("Stapled ticket validation failed");
        }
        return mock.command(program, args, options);
      },
    }),
    /ticket validation failed/,
  );
  assert.equal(attempts, 2);
  assert.equal(validations, 1, "must not retry a validation failure");
  assert(!mock.calls.some((call) => call.program === "archive"));
  assert(!fs.existsSync(path.join(f.release, "harness-mac-verification.json")));
});

test("rejected notarization cannot emit successful proof or updater metadata", async (t) => {
  const f = fixture(t);
  const mock = packagingMocks(f, "Invalid");
  await assert.rejects(
    finalizeMacRelease({
      harnessRoot: f.root,
      stageRoot: f.stageRoot,
      version: "0.3.4",
      outputDir: f.release,
      env: f.env,
      platform: "darwin",
      runCommand: mock.command,
      packagingTools: mock.tools,
    }),
    /did not accept/,
  );
  assert(!fs.existsSync(path.join(f.release, "harness-mac-verification.json")));
  assert(!mock.calls.some((call) => call.args.includes("--artifact")));
});

for (const version of ["0.3.4", "0.3.4-nightly.20260912.42"]) {
  for (const failure of ["command", "binding"]) {
    test(`${version} ${failure} proof failure cannot emit updater or success metadata`, async (t) => {
      const f = fixture(t, version),
        mock = packagingMocks(f);
      await assert.rejects(
        finalizeMacRelease({
          harnessRoot: f.root,
          stageRoot: f.stageRoot,
          version,
          outputDir: f.release,
          env: f.env,
          platform: "darwin",
          packagingTools: mock.tools,
          verifyBoot: async () => ({ healthyForMs: 5000 }),
          runCommand: (program, args, options) => {
            if (program === process.execPath && args.includes("--artifact")) {
              if (failure === "command") throw new Error("fixture: proof command failed");
              const result = mock.command(program, args, options);
              const proofPath = path.join(f.release, "tritonai-plugin-composition-mac-arm64.json");
              const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
              proof.artifacts[0].size += 1;
              fs.writeFileSync(proofPath, JSON.stringify(proof));
              return result;
            }
            return mock.command(program, args, options);
          },
        }),
        failure === "command" ? /proof command failed/ : /not bound to the exact/,
      );
      assert(!fs.existsSync(path.join(f.release, "latest-mac.yml")));
      assert(!fs.existsSync(path.join(f.release, "nightly-mac.yml")));
      assert(!fs.existsSync(path.join(f.release, "harness-mac-verification.json")));
    });
  }
}

test("signed payload validation failure stops before ZIP copying, notarization, or success proof", async (t) => {
  const f = fixture(t),
    mock = packagingMocks(f);
  await assert.rejects(
    finalizeMacRelease({
      harnessRoot: f.root,
      stageRoot: f.stageRoot,
      version: "0.3.4",
      outputDir: f.release,
      env: f.env,
      platform: "darwin",
      packagingTools: mock.tools,
      runCommand: (program, args, options) => {
        if (args[0] === "scripts/verify-macos-desktop-package.ts")
          throw new Error("fixture: native binary missing");
        return mock.command(program, args, options);
      },
    }),
    /native binary missing/,
  );
  assert(!mock.calls.some((call) => call.args[0] === "notarytool"));
  assert(!fs.existsSync(path.join(f.release, "TritonAI-Harness-0.3.4-arm64.zip")));
  assert(!fs.existsSync(path.join(f.release, "harness-mac-verification.json")));
});

test("nightly finalization preserves product identity and writes only the nightly updater", async (t) => {
  const version = "0.3.4-nightly.20260912.42";
  const f = fixture(t, version);
  const mock = packagingMocks(f);
  const report = await finalizeMacRelease({
    harnessRoot: f.root,
    stageRoot: f.stageRoot,
    version,
    outputDir: f.release,
    env: f.env,
    platform: "darwin",
    runCommand: mock.command,
    packagingTools: mock.tools,
    verifyBoot: async ({ appPath }) => {
      assert.equal(path.basename(appPath), "TritonAI Harness (Nightly).app");
      return { healthyForMs: 5000 };
    },
  });
  assert.equal(report.version, version);
  assert.match(
    fs.readFileSync(path.join(f.release, "nightly-mac.yml"), "utf8"),
    /0\.3\.4-nightly\.20260912\.42/,
  );
  assert.equal(fs.existsSync(path.join(f.release, "latest-mac.yml")), false);
  assert(mock.calls.some((c) => c.args.includes("TritonAI Harness (Nightly)")));
  for (const invalid of ["0.3.4-nightly", "0.3.4-nightly.20260912", "0.3.4-rc.1"])
    assert.throws(() => macReleaseIdentity(invalid), /release version/);
});
