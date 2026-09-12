const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const publish = require("./publish-nightly.cjs");

function fixture(t) {
  const cwd = process.cwd(),
    previous = { ...process.env };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publish-nightly-"));
  fs.mkdirSync(path.join(root, "release-assets"));
  fs.writeFileSync(path.join(root, "release-assets", "SHA256SUMS.txt"), "verified separately");
  fs.writeFileSync(
    path.join(root, "release-assets", "harness-win-verification.json"),
    JSON.stringify({ signingMode: "unsigned" }),
  );
  process.chdir(root);
  Object.assign(process.env, {
    NIGHTLY_TAG: "v0.3.4-nightly.20260912.1",
    NIGHTLY_NAME: "Nightly",
    SOURCE_SHA: "a".repeat(40),
  });
  t.after(() => {
    process.chdir(cwd);
    for (const key of ["NIGHTLY_TAG", "NIGHTLY_NAME", "SOURCE_SHA"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const context = {
    sha: "a".repeat(40),
    ref: "refs/heads/main",
    repo: { owner: "dbalders", repo: "TritonAI-Harness" },
    payload: { repository: { default_branch: "main" } },
  };
  const calls = [],
    release = {
      id: 7,
      assets: [],
      html_url: "https://github.com/dbalders/TritonAI-Harness/releases/tag/nightly",
    };
  const repos = {
    getLatestRelease: async () => ({ data: { id: 1, tag_name: "v0.3.3" } }),
    getReleaseByTag: async () => {
      throw Object.assign(new Error("absent"), { status: 404 });
    },
    createRelease: async (args) => {
      calls.push(["create", args]);
      Object.assign(release, args);
      return { data: release };
    },
    uploadReleaseAsset: async (args) => {
      release.assets.push({ name: args.name });
    },
    getRelease: async () => ({ data: release }),
    updateRelease: async (args) => {
      calls.push(["update", args]);
      Object.assign(release, args);
    },
    getCommit: async () => ({ data: { sha: context.sha } }),
  };
  return { github: { rest: { repos } }, context, calls, release };
}

test("creates a nightly draft, uploads all assets, then publishes without stable promotion", async (t) => {
  const f = fixture(t);
  await publish(f);
  assert.equal(f.calls.length, 2);
  for (const [, args] of f.calls) {
    assert.equal(args.prerelease, true);
    assert.equal(args.make_latest, "false");
  }
  assert.equal(f.calls[0][1].draft, true);
  assert.equal(f.calls[1][1].draft, false);
  assert.equal(f.calls[0][1].target_commitish, f.context.sha);
});

test("stable 0.3.4 is rejected before any release mutation", async (t) => {
  const f = fixture(t);
  process.env.NIGHTLY_TAG = "v0.3.4";
  await assert.rejects(publish(f), /Stable releases are forbidden/);
  assert.equal(f.calls.length, 0);
});

test("failed upload leaves the nightly draft unpublished", async (t) => {
  const f = fixture(t);
  f.github.rest.repos.uploadReleaseAsset = async () => {
    throw new Error("upload failed");
  };
  await assert.rejects(publish(f), /upload failed/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.release.draft, true);
});
