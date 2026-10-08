async function resolveStableMobile({ github, context, tag, sourceSha, allowMain = false }) {
  if (!tag) {
    if (!allowMain) throw new Error("Current main builds require manual dispatch");
    const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: "main" });
    if (!/^[a-f0-9]{40}$/.test(commit.sha) || (sourceSha && sourceSha !== commit.sha)) {
      throw new Error("Main does not match the requested source commit");
    }
    return commit.sha;
  }
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Select a stable Harness release tag");
  const { data: release } = await github.rest.repos.getReleaseByTag({ ...context.repo, tag });
  if (release.draft || release.prerelease || release.tag_name !== tag) {
    throw new Error("Mobile builds require a published stable release");
  }
  const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
  if (!/^[a-f0-9]{40}$/.test(commit.sha) || (sourceSha && sourceSha !== commit.sha)) {
    throw new Error("Stable tag does not match the requested source commit");
  }
  return commit.sha;
}
module.exports = { resolveStableMobile };
