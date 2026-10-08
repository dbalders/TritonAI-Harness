const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveStableMobile } = require("./resolve-stable-mobile.cjs");

const tag = "v0.3.5";
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
            return { data: { tag_name: tag, draft: false, prerelease: false, ...release } };
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

test("uses the published stable commit even when main has moved", async () => {
  assert.equal(await resolveStableMobile(fixture()), sha);
  assert.equal(await resolveStableMobile({ ...fixture(), sourceSha: undefined }), sha);
});

test("rejects nightly tags, branches, and shell input", async () => {
  for (const invalid of ["main", "v0.3.5-nightly.20261001.45", "nightly", `${tag}; echo unsafe`]) {
    await assert.rejects(
      resolveStableMobile({ ...fixture(), tag: invalid }),
      /stable Harness release/,
    );
  }
});

test("rejects drafts, prereleases, and mismatched release tags", async () => {
  for (const release of [{ draft: true }, { prerelease: true }, { tag_name: "other" }]) {
    await assert.rejects(resolveStableMobile(fixture(release)), /published stable/);
  }
});

test("rejects a moved tag and invalid commit identity", async () => {
  for (const commit of ["b".repeat(40), "main", ""]) {
    await assert.rejects(resolveStableMobile(fixture({}, commit)), /source commit/);
  }
});

test("fails closed when release lookup fails", async () => {
  const options = fixture();
  options.github.rest.repos.getReleaseByTag = async () => {
    throw new Error("not found");
  };
  await assert.rejects(resolveStableMobile(options), /not found/);
});

test("current main is allowed only for the explicitly manual first build", async () => {
  const f = fixture();
  f.tag = undefined;
  f.github.rest.repos.getCommit = async ({ ref }) => {
    assert.equal(ref, "main");
    return { data: { sha } };
  };
  await assert.rejects(resolveStableMobile(f), /manual dispatch/);
  assert.equal(await resolveStableMobile({ ...f, allowMain: true }), sha);
  await assert.rejects(
    resolveStableMobile({ ...f, allowMain: true, sourceSha: "b".repeat(40) }),
    /requested source/,
  );
});
