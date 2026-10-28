const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const { createRequire } = require("node:module");
const { parse } = createRequire(path.resolve("scripts/package.json"))("yaml");
const {
  verifyControlledReleaseAssets,
} = require("../../scripts/verify-controlled-release-assets.cjs");

for (const [version, channel, prerelease] of [
  ["1.2.3", "stable", "false"],
  ["1.2.3-rc.1", "stable", "true"],
  ["1.2.3-preview.1", "preview", "true"],
  ["v1.2.3-preview", "preview", "true"],
  ["1.2.3-nightly.20261017.1", null, null],
  ["1.2.3-nightly-invalid", null, null],
]) {
  test(
    `resolves ${version} before evaluating the announcement guard`,
    { skip: os.platform() === "win32" },
    (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-channel-"));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const output = path.join(root, "output");
      const workflow = parse(
        fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8"),
      );
      const resolver = workflow.jobs.resolve_release.steps.find(
        (step) => step.id === "release_meta",
      );
      const result = cp.spawnSync("bash", ["-e", "-o", "pipefail", "-c", resolver.run], {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: process.env.PATH,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          DISPATCH_VERSION: version,
          GITHUB_OUTPUT: output,
        },
      });
      if (channel === null) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Nightly/);
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      const resolved = Object.fromEntries(
        fs
          .readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
      assert.equal(resolved.release_channel, channel);
      assert.equal(resolved.is_prerelease, prerelease);
      assert.equal(resolved.make_latest, prerelease === "false" ? "true" : "false");
      const announce = new Function(
        "github",
        "inputs",
        "needs",
        "always",
        "cancelled",
        `return (${workflow.jobs.announce_discord.if});`,
      );
      assert.equal(
        announce(
          { event_name: "workflow_dispatch" },
          { publish: true },
          {
            preflight: { result: "success", outputs: resolved },
            release: { result: "success" },
            finalize: { result: "success" },
          },
          () => true,
          () => false,
        ),
        channel !== "preview",
      );
    },
  );
}

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

// regression: #236 fix(desktop): harden macOS updates and release validation
test("accepts complete Stable assets but blocks a corrupt updater ZIP", (t) => {
  const f = fixture(t);
  assert.equal(verifyControlledReleaseAssets(f.root, f.version), path.join(f.root, `${f.mac}.zip`));
  fs.appendFileSync(path.join(f.root, `${f.mac}.zip`), "corrupt");
  assert.throws(() => verifyControlledReleaseAssets(f.root, f.version), /size differs/);
});
// regression: #236 fix(desktop): harden macOS updates and release validation
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
// regression: #236 fix(desktop): harden macOS updates and release validation
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

// regression: #260 fix(release): leave controlled builds as drafts by default
test("controlled releases publish only after an explicit manual opt-in", () => {
  const workflow = parse(fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8"));
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.concurrency.queue, "max");
  assert.equal(workflow.jobs.resolve_release.permissions.contents, "write");
  assert(workflow.jobs.resolve_release.steps.every((step) => !step.uses));
  assert.equal(workflow.jobs.preflight.permissions.contents, "read");
  assert.deepEqual(workflow.jobs.preflight.needs, ["resolve_release"]);
  assert.equal(workflow.jobs.preflight.steps[0].with["persist-credentials"], false);
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
      workflow.jobs.release.steps.find((step) => step.id === "app_token").if,
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
