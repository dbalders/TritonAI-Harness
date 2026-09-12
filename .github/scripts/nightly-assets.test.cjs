const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateNightlyAssets } = require("../../scripts/validate-nightly-assets.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "0.3.4-nightly.20260912.1",
    sha = "a".repeat(40);
  const mac = `TritonAI-Harness-${version}-arm64`,
    win = `TritonAI-Harness-${version}-x64`;
  const artifacts = {};
  for (const name of [`${mac}.zip`, `${mac}.dmg`, `${win}.exe`]) {
    const bytes = Buffer.from(name);
    fs.writeFileSync(path.join(root, name), bytes);
    fs.writeFileSync(path.join(root, `${name}.blockmap`), "blockmap");
    artifacts[name] = {
      fileName: name,
      size: bytes.length,
      sha512: crypto.createHash("sha512").update(bytes).digest("base64"),
    };
  }
  const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  for (const [name, names] of [
    ["nightly-mac.yml", [`${mac}.zip`, `${mac}.dmg`]],
    ["nightly.yml", [`${win}.exe`]],
  ])
    save(name, {
      version,
      files: names.map((n) => ({ url: n, size: artifacts[n].size, sha512: artifacts[n].sha512 })),
      path: names[0],
      sha512: artifacts[names[0]].sha512,
    });
  const composition = { kind: "tritonai-harness-plugin-composition", packages: [{ id: "github" }] };
  save("tritonai-plugin-composition-mac-arm64.json", {
    ...composition,
    artifacts: [artifacts[`${mac}.dmg`]],
  });
  save("tritonai-plugin-composition-win-x64.json", {
    ...composition,
    artifacts: [artifacts[`${win}.exe`]],
  });
  save("harness-win-verification.json", {
    version,
    sourceCommit: sha,
    packagedBoot: true,
    signingMode: "unsigned",
  });
  const report = {
    version,
    sourceCommit: sha,
    notarization: { status: "Accepted" },
    boot: {
      version,
      packaged: true,
      visibleWindow: true,
      rendererReady: true,
      isolatedUserData: true,
      healthyForMs: 5000,
    },
    artifacts: [artifacts[`${mac}.zip`], artifacts[`${mac}.dmg`]],
  };
  save("harness-mac-verification.json", report);
  return { root, version, sha, mac, win, report, save };
}

test("validates both exact platform artifacts and rejects corruption", (t) => {
  const f = fixture(t);
  assert.match(validateNightlyAssets(f.root, f.version, f.sha), /nightly-mac.yml/);
  fs.appendFileSync(path.join(f.root, `${f.win}.exe`), "changed");
  assert.throws(() => validateNightlyAssets(f.root, f.version, f.sha));
});

test("rejects stable metadata, missing platforms, and failed notarization or boot", (t) => {
  const f = fixture(t);
  assert.throws(() => validateNightlyAssets(f.root, "0.3.4", f.sha));
  assert.throws(() => validateNightlyAssets(f.root, f.version, "b".repeat(40)));
  f.report.notarization.status = "Invalid";
  f.save("harness-mac-verification.json", f.report);
  assert.throws(() => validateNightlyAssets(f.root, f.version, f.sha));
  f.report.notarization.status = "Accepted";
  f.report.boot.rendererReady = false;
  f.save("harness-mac-verification.json", f.report);
  assert.throws(() => validateNightlyAssets(f.root, f.version, f.sha));
  f.report.boot.rendererReady = true;
  f.save("harness-mac-verification.json", f.report);
  fs.writeFileSync(path.join(f.root, "latest.yml"), "stable");
  assert.throws(() => validateNightlyAssets(f.root, f.version, f.sha));
  fs.unlinkSync(path.join(f.root, "latest.yml"));
  fs.unlinkSync(path.join(f.root, `${f.win}.exe`));
  assert.throws(() => validateNightlyAssets(f.root, f.version, f.sha));
});
