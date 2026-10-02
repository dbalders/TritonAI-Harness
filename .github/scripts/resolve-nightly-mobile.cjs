async function resolveNightlyMobile({ github, context, tag, sourceSha }) {
  if (!/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag)) {
    throw new Error("Select a dated Harness nightly release tag.");
  }
  const { data: release } = await github.rest.repos.getReleaseByTag({
    ...context.repo,
    tag,
  });
  if (release.draft || !release.prerelease || release.tag_name !== tag) {
    throw new Error("Mobile builds require a published nightly prerelease.");
  }
  const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
  if (!/^[a-f0-9]{40}$/.test(commit.sha) || (sourceSha && sourceSha !== commit.sha)) {
    throw new Error("Nightly tag does not match the requested source commit.");
  }
  return commit.sha;
}

module.exports = { resolveNightlyMobile };
