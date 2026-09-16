const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("yaml");
const { verifyMacosUpdateZip } = require("./verify-macos-update-zip.cjs");

function verifyControlledReleaseAssets(root, version) {
  assert(
    /^\d+\.\d+\.\d+(?:-(?!nightly)[0-9A-Za-z.-]+)?$/.test(version),
    "Nightly releases must use the nightly publication workflow.",
  );
  const channel = "latest";
  const mac = `TritonAI-Harness-${version}-arm64`;
  const win = `TritonAI-Harness-${version}-x64`;
  const expectedAssets = [
    ...[`${mac}.dmg`, `${mac}.zip`, `${win}.exe`].flatMap((name) => [name, `${name}.blockmap`]),
    `${channel}-mac.yml`,
    `${channel}.yml`,
    "tritonai-plugin-composition-mac-arm64.json",
    "tritonai-plugin-composition-win-x64.json",
  ];
  assert.deepEqual(
    fs.readdirSync(root).sort(),
    expectedAssets.sort(),
    "Controlled release assets must match the exact expected set; remove stale or unexpected draft assets before publication.",
  );
  const read = (name) => {
    assert.equal(path.basename(name), name, "Release assets must be flat file names.");
    const file = path.join(root, name);
    assert(fs.lstatSync(file).isFile(), `Missing regular release asset: ${name}`);
    const bytes = fs.readFileSync(file);
    assert(bytes.length > 0, `Empty release asset: ${name}`);
    return bytes;
  };
  const verifyArtifact = (artifact) => {
    const bytes = read(artifact.url ?? artifact.fileName);
    assert.equal(artifact.size, bytes.length, "Release artifact size differs from metadata.");
    assert.equal(
      artifact.sha512,
      crypto.createHash("sha512").update(bytes).digest("base64"),
      "Release artifact checksum differs from metadata.",
    );
  };
  for (const [file, names] of [
    [`${channel}-mac.yml`, [`${mac}.dmg`, `${mac}.zip`]],
    [`${channel}.yml`, [`${win}.exe`]],
  ]) {
    const manifest = parse(read(file).toString("utf8"));
    assert.equal(manifest.version, version, "Updater manifest has the wrong version.");
    assert.deepEqual(
      manifest.files.map((entry) => entry.url).sort(),
      names.toSorted(),
      "Updater manifest does not reference the required release artifacts.",
    );
    manifest.files.forEach(verifyArtifact);
    assert(names.includes(manifest.path));
    assert.equal(
      manifest.sha512,
      crypto.createHash("sha512").update(read(manifest.path)).digest("base64"),
    );
    for (const name of names) read(`${name}.blockmap`);
  }
  const compositions = [];
  for (const [file, artifactName] of [
    ["tritonai-plugin-composition-mac-arm64.json", `${mac}.dmg`],
    ["tritonai-plugin-composition-win-x64.json", `${win}.exe`],
  ]) {
    const { artifacts, ...composition } = JSON.parse(read(file));
    assert.equal(composition.kind, "tritonai-harness-plugin-composition");
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].fileName, artifactName);
    verifyArtifact(artifacts[0]);
    compositions.push(composition);
  }
  assert.deepEqual(compositions[0], compositions[1], "Platform plugin compositions differ.");
  return path.join(root, `${mac}.zip`);
}

module.exports = { verifyControlledReleaseAssets };
if (require.main === module) {
  const [root, version] = process.argv.slice(2);
  Promise.resolve()
    .then(() => verifyMacosUpdateZip(verifyControlledReleaseAssets(root, version)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
