const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveNightlyMobile } = require("./resolve-nightly-mobile.cjs");

const tag = "v0.3.5-nightly.20261001.45";
const sha = "a".repeat(40);
function fixture(release = {}, commitSha = sha) {
  return {
    tag,
    sourceSha: sha,
    context: { repo: { owner: "dbalders", repo: "TritonAI-Harness" } },
    github: {
      rest: {
        repos: {
          async getReleaseByTag() {
            return { data: { tag_name: tag, draft: false, prerelease: true, ...release } };
          },
          async getCommit({ ref }) {
            assert.equal(ref, tag);
            return { data: { sha: commitSha } };
          },
        },
      },
    },
  };
}

test("rejects stable tags, branches, and shell input", async () => {
  for (const invalid of ["main", "v0.3.5", "nightly", `${tag}; echo unsafe`]) {
    await assert.rejects(
      resolveNightlyMobile({ ...fixture(), tag: invalid }),
      /dated Harness nightly/,
    );
  }
});

test("rejects drafts, stable releases, and mismatched release tags", async () => {
  for (const release of [{ draft: true }, { prerelease: false }, { tag_name: "other" }]) {
    await assert.rejects(resolveNightlyMobile(fixture(release)), /published nightly/);
  }
});

test("rejects a moved tag and invalid commit identity", async () => {
  for (const commit of ["b".repeat(40), "main", ""]) {
    await assert.rejects(resolveNightlyMobile(fixture({}, commit)), /source commit/);
  }
});
