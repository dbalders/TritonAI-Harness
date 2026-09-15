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
    PREVIOUS_NIGHTLY_TAG: "v0.3.4-nightly.20260911.9",
    SOURCE_SHA: "a".repeat(40),
  });
  t.after(() => {
    process.chdir(cwd);
    for (const key of ["NIGHTLY_TAG", "NIGHTLY_NAME", "SOURCE_SHA", "PREVIOUS_NIGHTLY_TAG"]) {
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
    generateReleaseNotes: async (args) => {
      assert.equal(args.target_commitish, context.sha);
      assert.equal(args.previous_tag_name, process.env.PREVIOUS_NIGHTLY_TAG || "v0.3.3");
      return {
        data: {
          body: "## What’s Changed\n* Feature by @author in https://github.com/dbalders/TritonAI-Harness/pull/123\n\n**Full Changelog**: compare-link",
        },
      };
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

test("includes generated PR notes before platform details", async (t) => {
  const f = fixture(t);
  await publish(f);
  assert.match(f.release.body, /pull\/123/);
  assert.match(f.release.body, /Full Changelog/);
  assert.match(f.release.body, /SmartScreen may show a warning/);
  assert.ok(f.release.body.indexOf("What’s Changed") < f.release.body.indexOf("Platform notes"));
});

test("first nightly compares against the latest stable release", async (t) => {
  const f = fixture(t);
  delete process.env.PREVIOUS_NIGHTLY_TAG;
  await publish(f);
});

test("note generation failure prevents release creation", async (t) => {
  const f = fixture(t);
  f.github.rest.repos.generateReleaseNotes = async () => {
    throw new Error("notes unavailable");
  };
  await assert.rejects(publish(f), /notes unavailable/);
  assert.equal(f.calls.length, 0);
});

test("empty generated notes prevent release creation", async (t) => {
  const f = fixture(t);
  f.github.rest.repos.generateReleaseNotes = async () => ({ data: { body: " " } });
  await assert.rejects(publish(f), /notes are empty/);
  assert.equal(f.calls.length, 0);
});

test("signed Windows builds do not show an unsigned installer warning", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    "release-assets/harness-win-verification.json",
    JSON.stringify({ signingMode: "signed" }),
  );
  await publish(f);
  assert.doesNotMatch(f.release.body, /unsigned|SmartScreen/);
});
