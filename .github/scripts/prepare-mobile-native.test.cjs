const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { prepareMobileNative } = require("./prepare-mobile-native.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stable-mobile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  fs.mkdirSync(path.join(root, "apps/mobile"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps/mobile/.gitignore"), "/ios\n");
  fs.writeFileSync(path.join(root, "source.txt"), "stable source\n");
  fs.mkdirSync(path.join(root, ".repos/reference"), { recursive: true });
  fs.writeFileSync(path.join(root, ".repos/reference/unused.txt"), "desktop reference\n");
  fs.writeFileSync(path.join(root, ".gitmodules"), "# desktop references\n");
  fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github/workflows/desktop.yml"), "name: Desktop\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "stable source");
  const sourceSha = git("rev-parse", "HEAD");
  const ios = path.join(root, "apps/mobile/ios");
  const projectDirectory = path.join(ios, "TritonAIHarness.xcodeproj");
  const schemeDirectory = path.join(projectDirectory, "xcshareddata/xcschemes");
  fs.mkdirSync(schemeDirectory, { recursive: true });
  const project = path.join(projectDirectory, "project.pbxproj");
  fs.writeFileSync(
    project,
    ["", ".widgets", ".sharing"]
      .map(
        (bundle) =>
          `PRODUCT_BUNDLE_IDENTIFIER = edu.ucsd.tritonai.harness${bundle};\nDEVELOPMENT_TEAM = G789749RTK;`,
      )
      .join("\n"),
  );
  const scheme = path.join(schemeDirectory, "TritonAIHarness.xcscheme");
  fs.writeFileSync(
    scheme,
    '<Scheme><BuildActionEntry buildForArchiving = "YES"/><ArchiveAction/></Scheme>',
  );
  const swiftpm = path.join(ios, "TritonAIHarness.xcworkspace/xcshareddata/swiftpm");
  fs.mkdirSync(swiftpm, { recursive: true });
  fs.writeFileSync(
    path.join(swiftpm, "Package.resolved"),
    JSON.stringify({ version: 3, pins: [{ identity: "clerk-ios" }] }),
  );
  return {
    root,
    ios,
    git,
    project,
    scheme,
    options: {
      root,
      sourceSha,
      generatorSha: "a".repeat(40),
      tag: "v0.3.5",
      variant: "production",
    },
  };
}

test("stages native sources and provenance without changing the stable source", (t) => {
  const f = fixture(t);
  for (const name of ["Pods", "build", "DerivedData", "xcuserdata"]) {
    fs.mkdirSync(path.join(f.ios, name));
    fs.writeFileSync(path.join(f.ios, name, "private.txt"), "local artifact");
  }
  fs.writeFileSync(path.join(f.ios, ".xcode.env.local"), "local environment");
  fs.writeFileSync(path.join(f.ios, "Podfile.lock"), "local pod resolution");
  const tree = prepareMobileNative(f.options);
  assert.equal(f.git("rev-parse", "HEAD"), f.options.sourceSha);
  assert.equal(f.git("show", `${tree}:source.txt`), "stable source");
  assert.deepEqual(
    JSON.parse(f.git("show", `${tree}:apps/mobile/ios/ci_scripts/stable-source.json`)),
    {
      tag: f.options.tag,
      sourceSha: f.options.sourceSha,
      generatorSha: f.options.generatorSha,
      variant: "production",
    },
  );
  const files = f.git("ls-tree", "-r", "--name-only", tree).split("\n");
  assert.ok(!files.some((file) => /^(?:\.repos\/|\.gitmodules$|\.github\/workflows\/)/.test(file)));
  assert.equal(
    fs.readFileSync(path.join(f.root, ".repos/reference/unused.txt"), "utf8"),
    "desktop reference\n",
  );
  assert.ok(files.includes("apps/mobile/ios/TritonAIHarness.xcworkspace/contents.xcworkspacedata"));
  assert.ok(files.includes("apps/mobile/ios/ci_scripts/ci_post_clone.sh"));
  assert.ok(
    files.includes(
      "apps/mobile/ios/TritonAIHarness.xcworkspace/xcshareddata/swiftpm/Package.resolved",
    ),
  );
  assert.ok(
    !files.some((file) =>
      /Pods|DerivedData|xcuserdata|private.txt|\.xcode.env.local|Podfile.lock/.test(file),
    ),
  );
  assert.match(f.git("ls-tree", tree, "apps/mobile/ios/ci_scripts/ci_post_clone.sh"), /^100755 /);
});

test("rejects nightly tags, invalid SHAs, wrong source, and edited source", (t) => {
  const f = fixture(t);
  assert.throws(
    () => prepareMobileNative({ ...f.options, tag: "v0.3.5-nightly.20261001.45" }),
    /stable tag/,
  );
  assert.throws(() => prepareMobileNative({ ...f.options, generatorSha: "main" }), /commit SHAs/);
  assert.throws(
    () => prepareMobileNative({ ...f.options, sourceSha: "b".repeat(40) }),
    /exact mobile source/,
  );
  fs.writeFileSync(path.join(f.root, "source.txt"), "edited source");
  assert.throws(() => prepareMobileNative(f.options));
});

test("rejects another app or team before staging files", (t) => {
  const f = fixture(t);
  const original = fs.readFileSync(f.project, "utf8");
  fs.writeFileSync(f.project, original.replace("harness.widgets", "harness.preview.widgets"));
  assert.throws(() => prepareMobileNative(f.options), /only the production/);
  fs.writeFileSync(f.project, original.replaceAll("G789749RTK", "DTZW32QN7F"));
  assert.throws(() => prepareMobileNative(f.options), /UCSD team/);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
});

test("rejects missing archive support, signing credentials, and symlinks", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.scheme, "<Scheme/>");
  assert.throws(() => prepareMobileNative(f.options), /supports archiving/);
  fs.writeFileSync(
    f.scheme,
    '<Scheme><BuildActionEntry buildForArchiving="YES"/><ArchiveAction/></Scheme>',
  );
  const key = path.join(f.ios, "distribution.p12");
  fs.writeFileSync(key, "test credential");
  assert.throws(() => prepareMobileNative(f.options), /signing credentials/);
  fs.rmSync(key);
  fs.symlinkSync(path.join(f.root, "source.txt"), path.join(f.ios, "linked.txt"));
  assert.throws(() => prepareMobileNative(f.options), /symlinks/);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
});

test("prepares an explicitly requested current-main production build", (t) => {
  const f = fixture(t);
  const tree = prepareMobileNative({ ...f.options, tag: "main" });
  const receipt = JSON.parse(
    f.git("show", `${tree}:apps/mobile/ios/ci_scripts/stable-source.json`),
  );
  assert.equal(receipt.tag, "main");
  assert.equal(receipt.variant, "production");
});

test("records the allocated stable marketing version without editing release sources", (t) => {
  const f = fixture(t);
  const tree = prepareMobileNative({ ...f.options, marketingVersion: "1.4.2" });
  const receipt = JSON.parse(
    f.git("show", `${tree}:apps/mobile/ios/ci_scripts/stable-source.json`),
  );
  assert.equal(receipt.marketingVersion, "1.4.2");
  assert.equal(f.git("rev-parse", "HEAD"), f.options.sourceSha);
  assert.equal(f.git("diff", "--name-only", "HEAD", "--", "source.txt"), "");
  assert.throws(
    () => prepareMobileNative({ ...f.options, marketingVersion: "1.4.2; unsafe" }),
    /Marketing version/,
  );
});

test("Xcode Cloud applies the stable marketing version and build number to every target", (t) => {
  const f = fixture(t);
  const scripts = path.join(f.ios, "ci_scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(
    path.join(scripts, "stable-source.json"),
    JSON.stringify({ tag: "v0.3.7", sourceSha: f.options.sourceSha, marketingVersion: "1.4.2" }),
  );
  fs.writeFileSync(
    path.join(f.root, "apps/mobile/app.config.ts"),
    'export default { version: "1.4.0" };\n',
  );
  const targets = ["TritonAIHarness", "ExpoWidgetsTarget", "expo-sharing-extension"];
  for (const target of targets) {
    fs.mkdirSync(path.join(f.ios, target), { recursive: true });
    fs.writeFileSync(
      path.join(f.ios, target, "Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.4.0</string></dict></plist>',
    );
  }
  fs.appendFileSync(
    f.project,
    "\n" + "CURRENT_PROJECT_VERSION = 1;\nMARKETING_VERSION = 1.4.0;\n".repeat(6),
  );
  const hook = fs.readFileSync(path.join(__dirname, "xcode-cloud/ci_post_clone.sh"), "utf8");
  const python = hook.split("python3 - <<'PY'\n")[1].split("\nPY")[0];
  execFileSync("python3", ["-c", python], {
    cwd: f.ios,
    env: { ...process.env, APP_VARIANT: "production", CI_BUILD_NUMBER: "42" },
  });
  const values = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        'import json,plistlib; from pathlib import Path; print(json.dumps([plistlib.loads(p.read_bytes()) for p in Path(".").glob("*/Info.plist")]))',
      ],
      { cwd: f.ios, encoding: "utf8" },
    ),
  );
  assert.match(
    fs.readFileSync(path.join(f.root, "apps/mobile/app.config.ts"), "utf8"),
    /version: "1\.4\.2"/,
  );
  assert.equal(values.length, 3);
  assert.ok(
    values.every(
      (info) => info.CFBundleShortVersionString === "1.4.2" && info.CFBundleVersion === "42",
    ),
  );
  assert.equal(
    [...fs.readFileSync(f.project, "utf8").matchAll(/MARKETING_VERSION = 1\.4\.2;/g)].length,
    6,
  );
});
