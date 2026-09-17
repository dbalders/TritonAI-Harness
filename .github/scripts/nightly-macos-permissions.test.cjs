const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { parse } = createRequire(path.resolve(__dirname, "../../scripts/package.json"))("yaml");
const {
  assertMacosBundlePermissions,
  verifyMacosUpdateZip,
} = require("../../scripts/verify-macos-update-zip.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nightly permissions "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Test.app");
  const contents = path.join(app, "Contents");
  const macos = path.join(contents, "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  fs.chmodSync(app, 0o755);
  fs.chmodSync(contents, 0o755);
  fs.chmodSync(macos, 0o755);
  fs.writeFileSync(
    path.join(contents, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Test</string></dict></plist>",
    { mode: 0o644 },
  );
  const executable = path.join(macos, "Test");
  const resource = path.join(contents, "resource");
  fs.writeFileSync(executable, "test");
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(resource, "test");
  fs.chmodSync(resource, 0o644);
  return { root, app, contents, executable, resource };
}

// This integration test exercises real filesystem modes and macOS ditto.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Test eligibility depends on the actual host, not a simulated platform.
const hostPlatform = process.platform;
const posix = { skip: hostPlatform === "win32" };
test("accepts readable resources and framework-style relative links", posix, (t) => {
  const { app, contents } = fixture(t);
  fs.symlinkSync("MacOS/Test", path.join(contents, "Current"));
  assert.doesNotThrow(() => assertMacosBundlePermissions(app));
});

for (const field of ["app", "contents", "executable", "resource"]) {
  test(`rejects owner-only ${field} access even when the build user can read it`, posix, (t) => {
    const bundle = fixture(t);
    fs.chmodSync(bundle[field], field === "resource" ? 0o600 : 0o700);
    fs.accessSync(bundle[field], fs.constants.R_OK);
    assert.throws(
      () => assertMacosBundlePermissions(bundle.app),
      /inaccessible after an administrator update/,
    );
  });
}

test("rejects a main executable that lost every execute bit", posix, (t) => {
  const { app, executable } = fixture(t);
  fs.chmodSync(executable, 0o644);
  assert.throws(() => assertMacosBundlePermissions(app), /has mode 644/);
});

for (const relative of [
  "Contents/Frameworks/Test Helper.app/Contents/MacOS/Test Helper",
  "Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
  "Contents/Resources/cua-driver/cua-driver",
  "Contents/Resources/resource-monitor/t3-resource-monitor",
  "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper",
]) {
  test(`rejects lost execute bits on packaged program ${relative}`, posix, (t) => {
    const { app } = fixture(t);
    const executable = path.join(app, relative);
    fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o755 });
    fs.writeFileSync(executable, "program", { mode: 0o755 });
    assert.doesNotThrow(() => assertMacosBundlePermissions(app));
    fs.chmodSync(executable, 0o644);
    assert.throws(() => assertMacosBundlePermissions(app), /has mode 644/);
  });
}

for (const [field, mode] of [
  ["app", 0o705],
  ["executable", 0o705],
  ["resource", 0o604],
  ["resource", 0o044],
]) {
  test(
    `rejects ${field} mode ${mode.toString(8)} even when other access is allowed`,
    posix,
    (t) => {
      const bundle = fixture(t);
      fs.chmodSync(bundle[field], mode);
      assert.throws(() => assertMacosBundlePermissions(bundle.app), /inaccessible/);
    },
  );
}

test(
  "checks preserved permissions in the actual updater ZIP",
  { skip: hostPlatform !== "darwin" },
  async (t) => {
    const { root, app } = fixture(t);
    const zip = path.join(root, "update.zip");
    const pack = () => execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
    fs.chmodSync(app, 0o700);
    pack();
    await assert.rejects(verifyMacosUpdateZip(zip), /has mode 700/);
    fs.rmSync(zip);
    fs.chmodSync(app, 0o755);
    pack();
    await verifyMacosUpdateZip(zip);
  },
);

test("workflow keeps the key private while packaging usable app permissions", posix, (t) => {
  const workflow = parse(
    fs.readFileSync(path.resolve(__dirname, "../workflows/nightly.yml"), "utf8"),
  );
  const command = workflow.jobs.mac.steps.find(
    (step) => step.name === "Sign, notarize, and verify packaged app",
  ).run;
  const { root } = fixture(t);
  const finalizer = path.join(root, ".release-input/installer/scripts/local-release-mac.cjs");
  fs.mkdirSync(path.dirname(finalizer), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  // Replace the external signing tool, then measure permissions inherited from
  // the real workflow shell. This never loads a signing identity or real key.
  fs.writeFileSync(
    finalizer,
    `const fs = require('node:fs');
    fs.mkdirSync('Packaged.app');
    fs.writeFileSync('Packaged.app/resource', 'public app payload');
    fs.writeFileSync('modes.json', JSON.stringify({
      key: fs.statSync(process.env.APPLE_API_KEY).mode & 0o777,
      app: fs.statSync('Packaged.app').mode & 0o777,
      resource: fs.statSync('Packaged.app/resource').mode & 0o777
    }));`,
  );
  fs.writeFileSync(path.join(root, "scripts/verify-macos-update-zip.cjs"), "");
  execFileSync("/bin/bash", ["-c", `umask 077\n${command}`], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      GITHUB_WORKSPACE: root,
      APPLE_API_KEY_CONTENT: "test fixture, not a signing key",
      NIGHTLY_VERSION: "0.3.4-nightly.20260916.19",
    },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "modes.json"), "utf8")), {
    key: 0o600,
    app: 0o755,
    resource: 0o644,
  });
});
