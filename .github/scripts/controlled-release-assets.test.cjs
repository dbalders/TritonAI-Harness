const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { parse } = createRequire(path.resolve("scripts/package.json"))("yaml");
const {
  verifyControlledReleaseAssets,
} = require("../../scripts/verify-controlled-release-assets.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stable-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "0.3.4";
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
    ["latest-mac.yml", [`${mac}.zip`, `${mac}.dmg`]],
    ["latest.yml", [`${win}.exe`]],
  ])
    save(name, {
      version,
      files: names.map((n) => ({ url: n, size: artifacts[n].size, sha512: artifacts[n].sha512 })),
      path: names[0],
      sha512: artifacts[names[0]].sha512,
    });
  const composition = { kind: "tritonai-harness-plugin-composition", packages: [{ id: "github" }] };
  for (const [platform, name] of [
    ["mac-arm64", `${mac}.dmg`],
    ["win-x64", `${win}.exe`],
  ])
    save(`tritonai-plugin-composition-${platform}.json`, {
      ...composition,
      artifacts: [artifacts[name]],
    });
  return { root, version, mac, win, save };
}

test("accepts complete Stable assets but blocks a corrupt updater ZIP", (t) => {
  const f = fixture(t);
  assert.equal(verifyControlledReleaseAssets(f.root, f.version), path.join(f.root, `${f.mac}.zip`));
  fs.appendFileSync(path.join(f.root, `${f.mac}.zip`), "corrupt");
  assert.throws(() => verifyControlledReleaseAssets(f.root, f.version), /size differs/);
});
test("blocks missing platform assets", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, `${f.win}.exe`));
  assert.throws(() => verifyControlledReleaseAssets(f.root, f.version));
});
for (const staleAsset of [
  "nightly-mac.yml",
  "TritonAI-Harness-0.3.3-x64.exe",
  "unexpected-build-output.json",
]) {
  test(`blocks an additional draft asset: ${staleAsset}`, (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, staleAsset), "stale draft content");
    assert.throws(() => verifyControlledReleaseAssets(f.root, f.version), /exact expected set/);
  });
}
test("blocks a feed pointing at another version or the Nightly track", (t) => {
  const f = fixture(t);
  assert.throws(
    () => verifyControlledReleaseAssets(f.root, "0.3.4-nightly.20260916.1"),
    /Nightly releases/,
  );
  const file = path.join(f.root, "latest-mac.yml");
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.version = "0.3.3";
  f.save("latest-mac.yml", manifest);
  assert.throws(() => verifyControlledReleaseAssets(f.root, f.version), /wrong version/);
});
test("controlled release verifies downloaded draft bytes before publishing", () => {
  const workflow = parse(fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8"));
  const steps = workflow.jobs.release.steps;
  const verify = steps.findIndex((step) => step.name === "Verify final controlled release assets");
  const publish = steps.findIndex((step) => step.name === "Publish controlled release");
  assert(verify > 0 && verify < publish);
  assert(steps.slice(0, verify).some((step) => step.id === "app_token"));
  assert.match(steps[verify].run, /gh release download/);
  assert.match(steps[verify].run, /verify-controlled-release-assets/);
  assert.match(steps[verify].run, /git rev-parse HEAD/);
});

test("controlled releases publish only after an explicit manual opt-in", () => {
  const workflow = parse(fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8"));
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.type, "boolean");
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  const publish = workflow.jobs.release.steps.find(
    (step) => step.name === "Publish controlled release",
  );
  const draft = workflow.jobs.release.steps.find(
    (step) => step.name === "Report draft ready for testing",
  );
  const evaluate = (expression, eventName, input) => {
    const condition = expression.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "");
    return new Function(
      "github",
      "inputs",
      "needs",
      "failure",
      "cancelled",
      "always",
      `return (${condition});`,
    )(
      { event_name: eventName },
      input === undefined ? {} : { publish: input },
      {
        preflight: { result: "success", outputs: { release_channel: "stable" } },
        release: { result: "success" },
        finalize: { result: "success" },
      },
      () => false,
      () => false,
      () => true,
    );
  };
  for (const [eventName, input, expected] of [
    ["push", undefined, false],
    ["push", true, false],
    ["workflow_dispatch", undefined, false],
    ["workflow_dispatch", false, false],
    ["workflow_dispatch", true, true],
  ]) {
    for (const condition of [
      publish.if,
      workflow.jobs.finalize.if,
      workflow.jobs.announce_discord.if,
    ]) {
      assert.equal(
        evaluate(condition, eventName, input),
        expected,
        `${eventName}/${input}: ${condition}`,
      );
    }
    assert.equal(evaluate(draft.if, eventName, input), !expected);
  }
  // Draft mode must still verify the actual downloaded release bytes.
  const verify = workflow.jobs.release.steps.find(
    (step) => step.name === "Verify final controlled release assets",
  );
  assert.equal(verify.if, undefined);
});
