const assert = require("node:assert/strict");
const test = require("node:test");
const { newestTrackBuild } = require("./mirror-play-apk.cjs");

// regression: d4dd8e9346 fix: address launcher and release workflow review findings
test("does not mirror PUBLISHED summaries whose rollout may be halted", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://play.invalid/app/tracks/v2/releases");
    assert.equal(options.method, "GET");
    return Response.json({
      releases: [
        {
          releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
          releaseName: "older",
          activeArtifacts: [{ versionCode: 42 }],
        },
        {
          releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
          releaseName: "possibly halted",
          activeArtifacts: [{ versionCode: 43 }],
        },
      ],
    });
  });
  await assert.rejects(newestTrackBuild("synthetic", "https://play.invalid/app", "v2"), {
    code: "PLAY_ROLLOUT_UNVERIFIED",
  });
});

// regression: d4dd8e9346 fix: address launcher and release workflow review findings
test("does not mirror draft, unreviewed or unpublished releases", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      releases: [
        {
          releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_DRAFT",
          activeArtifacts: [{ versionCode: 44 }],
        },
        {
          releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED",
          activeArtifacts: [{ versionCode: 45 }],
        },
      ],
    }),
  );
  assert.equal(await newestTrackBuild("synthetic", "https://play.invalid/app", "v2"), undefined);
});
