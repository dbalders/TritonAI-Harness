const fs = require("node:fs");
const path = require("node:path");
const { assertNightlyPublication } = require("./nightly-release.cjs");

module.exports = async function publishNightly({ github, context }) {
  const tag = process.env.NIGHTLY_TAG;
  const sha = process.env.SOURCE_SHA;
  assertNightlyPublication({
    repository: `${context.repo.owner}/${context.repo.repo}`,
    ref: context.ref,
    defaultBranch: context.payload.repository.default_branch,
    tag,
  });
  if (!/^[a-f0-9]{40}$/.test(sha) || sha !== context.sha)
    throw new Error("Nightly source must match the triggering commit.");
  const directory = path.resolve("release-assets");
  const files = fs.readdirSync(directory);
  if (!files.includes("SHA256SUMS.txt") || files.some((file) => file.startsWith("latest")))
    throw new Error("Only validated nightly assets may be published.");
  const { data: stableBefore } = await github.rest.repos.getLatestRelease(context.repo);
  try {
    await github.rest.repos.getReleaseByTag({ ...context.repo, tag });
    throw new Error("This nightly tag already has a release. Refusing to overwrite it.");
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const { data: release } = await github.rest.repos.createRelease({
    ...context.repo,
    tag_name: tag,
    target_commitish: sha,
    name: process.env.NIGHTLY_NAME,
    draft: true,
    prerelease: true,
    make_latest: "false",
    body: `Nightly build from ${sha}.\n\nmacOS Apple Silicon: Developer ID signed, notarized, and packaged-boot verified.\nWindows x64: explicitly unsigned, installed and boot verified on the hosted runner.\nBoth platforms include the validated managed-plugin composition.\n\nThis is an opt-in testing prerelease. Production 0.3.4 has not been released.\n\nSource commit: ${sha}`,
  });
  for (const name of files) {
    const data = fs.readFileSync(path.join(directory, name));
    await github.rest.repos.uploadReleaseAsset({
      ...context.repo,
      release_id: release.id,
      name,
      data,
      headers: { "content-type": "application/octet-stream", "content-length": data.length },
    });
  }
  const { data: draft } = await github.rest.repos.getRelease({
    ...context.repo,
    release_id: release.id,
  });
  if (
    !draft.draft ||
    !draft.prerelease ||
    draft.tag_name !== tag ||
    draft.assets.length !== files.length
  )
    throw new Error("Nightly draft failed final verification.");
  await github.rest.repos.updateRelease({
    ...context.repo,
    release_id: release.id,
    draft: false,
    prerelease: true,
    make_latest: "false",
  });
  const { data: published } = await github.rest.repos.getRelease({
    ...context.repo,
    release_id: release.id,
  });
  const { data: stableAfter } = await github.rest.repos.getLatestRelease(context.repo);
  if (published.draft || !published.prerelease || stableAfter.id !== stableBefore.id)
    throw new Error("Nightly publication state verification failed.");
  const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
  if (commit.sha !== sha)
    throw new Error("Published nightly tag differs from the verified source.");
  console.log(`Published nightly only: ${published.html_url}`);
};
