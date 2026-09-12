const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assertNightlyPublication, resolveNightly } = require("./nightly-release.cjs");

test("publication rejects stable tags, other repositories, and non-default branches", () => {
  const valid = {
    repository: "dbalders/TritonAI-Harness",
    ref: "refs/heads/main",
    defaultBranch: "main",
    tag: "v0.3.4-nightly.20260912.1",
  };
  assertNightlyPublication(valid);
  for (const tag of [
    "v0.3.4",
    "0.3.4",
    "v0.3.4-rc.1",
    "v0.3.4-nightly",
    "v0.3.4-nightly.20260912.0",
  ])
    assert.throws(() => assertNightlyPublication({ ...valid, tag }));
  assert.throws(() => assertNightlyPublication({ ...valid, ref: "refs/heads/test" }));
  assert.throws(() => assertNightlyPublication({ ...valid, repository: "pingdotgg/t3code" }));
});

function fixture(eventName, inputs = {}) {
  const outputs = {};
  const context = {
    eventName,
    sha: "a".repeat(40),
    ref: "refs/heads/main",
    repo: { owner: "dbalders", repo: "TritonAI-Harness" },
    payload: { repository: { default_branch: "main" }, inputs },
  };
  const github = {
    rest: {
      repos: {
        getLatestRelease: async () => ({
          data: { tag_name: "v0.3.3", prerelease: false, draft: false },
        }),
        listReleases() {},
        getCommit: async () => ({ data: { sha: context.sha } }),
      },
    },
    paginate: async () => [],
  };
  return {
    context,
    github,
    outputs,
    core: { setOutput: (k, v) => (outputs[k] = v), notice() {} },
    enabled: "1",
  };
}

test("manual proof builds without publishing; manual publication is explicit", async () => {
  const proof = fixture("workflow_dispatch");
  await resolveNightly(proof);
  assert.equal(proof.outputs.publish, "false");
  assert.equal(proof.outputs.build, "true");
  const publish = fixture("workflow_dispatch", { publish: "true" });
  await resolveNightly(publish);
  assert.equal(publish.outputs.publish, "true");
  assert.equal(publish.outputs.stable_version, "0.3.3");
});

test("schedule is opt-in and skips the latest published nightly source", async () => {
  const disabled = fixture("schedule");
  disabled.enabled = "";
  await resolveNightly(disabled);
  assert.equal(disabled.outputs.build, "false");
  const unchanged = fixture("schedule");
  unchanged.github.paginate = async () => [
    {
      tag_name: "v0.3.4-nightly.20260911.1",
      prerelease: true,
      draft: false,
      published_at: "2026-09-11T08:17:00Z",
    },
  ];
  await resolveNightly(unchanged);
  assert.equal(unchanged.outputs.build, "false");
  const changed = fixture("schedule");
  await resolveNightly(changed);
  assert.equal(changed.outputs.build, "true");
});
