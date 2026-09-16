const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
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
  const windows = JSON.parse(
    fs.readFileSync(path.join(directory, "harness-win-verification.json")),
  );
  const { data: notes } = await github.rest.repos.generateReleaseNotes({
    ...context.repo,
    tag_name: tag,
    target_commitish: sha,
    previous_tag_name: process.env.PREVIOUS_NIGHTLY_TAG || stableBefore.tag_name,
  });
  if (!notes.body?.trim()) throw new Error("Generated nightly release notes are empty.");
  const verifyExistingTag = async (message) => {
    try {
      await github.rest.git.getRef({ ...context.repo, ref: `tags/${tag}` });
    } catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    const { data: existingTag } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
    if (existingTag.sha !== sha) throw new Error(message);
  };
  await verifyExistingTag("Nightly tag differs from the verified source.");
  const { data: release } = await github.rest.repos.createRelease({
    ...context.repo,
    tag_name: tag,
    target_commitish: sha,
    name: process.env.NIGHTLY_NAME,
    draft: true,
    prerelease: true,
    make_latest: "false",
    body: `This is an opt-in nightly testing prerelease.\n\n${notes.body}\n\n## Platform notes\n\nmacOS: available for Apple Silicon Macs.\nWindows: available for x64 PCs.${windows.signingMode === "unsigned" ? " The Windows installer is unsigned, so Microsoft Defender SmartScreen may show a warning." : ""}\n\nSource commit: ${sha}`,
  });
  const expectedAssets = new Map();
  for (const name of files) {
    const data = fs.readFileSync(path.join(directory, name));
    expectedAssets.set(name, {
      size: data.length,
      digest: `sha256:${crypto.createHash("sha256").update(data).digest("hex")}`,
    });
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
    draft.target_commitish !== sha ||
    draft.assets.length !== files.length
  )
    throw new Error("Nightly draft failed final verification.");
  const seen = new Set();
  for (const asset of draft.assets) {
    const expected = expectedAssets.get(asset.name);
    if (
      !expected ||
      seen.has(asset.name) ||
      asset.state !== "uploaded" ||
      asset.size !== expected.size ||
      asset.digest !== expected.digest
    )
      throw new Error(`Nightly draft asset failed integrity verification: ${asset.name}`);
    seen.add(asset.name);
  }
  // Existing tags override target_commitish. Recheck after uploads, but leave
  // missing tags absent until publication: bare tags appear in GitHub's updater
  // feed even while their draft assets remain unavailable.
  await verifyExistingTag("Nightly draft tag differs from the verified source.");
  await github.rest.repos.updateRelease({
    ...context.repo,
    release_id: release.id,
    target_commitish: sha,
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
