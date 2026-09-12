const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { parse } = require("yaml");
const { NIGHTLY_TAG } = require("../.github/scripts/nightly-release.cjs");

function validateNightlyAssets(root, version, sourceSha) {
  assert(NIGHTLY_TAG.test(`v${version}`), "Stable versions cannot pass the nightly asset gate.");
  assert(/^[a-f0-9]{40}$/.test(sourceSha), "An exact source commit is required.");
  const mac = `TritonAI-Harness-${version}-arm64`;
  const win = `TritonAI-Harness-${version}-x64`;
  const expected = [
    `${mac}.dmg`,
    `${mac}.zip`,
    `${mac}.dmg.blockmap`,
    `${mac}.zip.blockmap`,
    `${win}.exe`,
    `${win}.exe.blockmap`,
    "nightly-mac.yml",
    "nightly.yml",
    "tritonai-plugin-composition-mac-arm64.json",
    "tritonai-plugin-composition-win-x64.json",
    "harness-mac-verification.json",
    "harness-win-verification.json",
  ].sort();
  assert.deepEqual(
    fs.readdirSync(root).sort(),
    expected,
    "Unexpected or missing nightly release assets.",
  );
  const read = (name) => {
    const file = path.join(root, name);
    assert(fs.lstatSync(file).isFile(), "Assets must be regular files.");
    return fs.readFileSync(file);
  };
  const sha512 = (bytes) => crypto.createHash("sha512").update(bytes).digest("base64");
  const verifyArtifact = (artifact) => {
    assert(expected.includes(artifact.fileName), "Unexpected artifact name.");
    const bytes = read(artifact.fileName);
    assert.equal(artifact.size, bytes.length);
    assert.equal(artifact.sha512, sha512(bytes));
  };
  for (const [file, names] of [
    ["nightly-mac.yml", [`${mac}.dmg`, `${mac}.zip`]],
    ["nightly.yml", [`${win}.exe`]],
  ]) {
    const manifest = parse(read(file).toString("utf8"));
    assert.equal(manifest.version, version);
    assert.deepEqual(manifest.files.map((f) => f.url).sort(), names.sort());
    for (const artifact of manifest.files) verifyArtifact({ ...artifact, fileName: artifact.url });
    assert(names.includes(manifest.path));
    assert.equal(manifest.sha512, sha512(read(manifest.path)));
  }
  const compositions = [];
  for (const [file, name] of [
    ["tritonai-plugin-composition-mac-arm64.json", `${mac}.dmg`],
    ["tritonai-plugin-composition-win-x64.json", `${win}.exe`],
  ]) {
    const { artifacts, ...composition } = JSON.parse(read(file));
    assert.equal(composition.kind, "tritonai-harness-plugin-composition");
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].fileName, name);
    verifyArtifact(artifacts[0]);
    compositions.push(composition);
  }
  assert.deepEqual(
    compositions[0],
    compositions[1],
    "Both platforms must ship the same managed plugin composition.",
  );
  const windows = JSON.parse(read("harness-win-verification.json"));
  assert.equal(windows.version, version);
  assert.equal(windows.sourceCommit, sourceSha);
  assert.equal(windows.packagedBoot, true);
  assert(["signed", "unsigned"].includes(windows.signingMode));
  const report = JSON.parse(read("harness-mac-verification.json"));
  assert.equal(report.version, version);
  assert.equal(report.sourceCommit, sourceSha);
  assert.equal(report.notarization.status, "Accepted");
  for (const key of ["packaged", "visibleWindow", "rendererReady", "isolatedUserData"])
    assert.equal(report.boot[key], true);
  assert.equal(report.boot.version, version);
  assert(report.boot.healthyForMs >= 5000);
  assert.equal(report.artifacts.length, 2);
  report.artifacts.forEach(verifyArtifact);
  const checksums =
    expected
      .map((name) => `${crypto.createHash("sha256").update(read(name)).digest("hex")}  ${name}`)
      .join("\n") + "\n";
  return checksums;
}

module.exports = { validateNightlyAssets };
if (require.main === module) {
  const [root, version, sourceSha] = process.argv.slice(2);
  const checksums = validateNightlyAssets(root, version, sourceSha);
  fs.writeFileSync(path.join(root, "SHA256SUMS.txt"), checksums);
  console.log(
    "Verified exact nightly assets, checksums, updater metadata, plugin composition, and signed Mac boot proof.",
  );
}
