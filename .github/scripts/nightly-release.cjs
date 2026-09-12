const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/;

function assertNightlyPublication({ repository, ref, defaultBranch, tag }) {
  if (repository !== "dbalders/TritonAI-Harness")
    throw new Error("Nightly publication is restricted to the downstream repository.");
  if (ref !== `refs/heads/${defaultBranch}`)
    throw new Error("Publish nightlies only from the default branch.");
  if (!NIGHTLY_TAG.test(tag))
    throw new Error(
      "Only dated nightly tags can be published. Stable releases are forbidden here.",
    );
}

async function resolveNightly({ github, context, core, enabled }) {
  const publish =
    context.eventName === "schedule" || String(context.payload.inputs?.publish) === "true";
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const defaultBranch = context.payload.repository.default_branch;
  if (publish)
    assertNightlyPublication({
      repository,
      ref: context.ref,
      defaultBranch,
      tag: "v0.0.0-nightly.20000101.1",
    });
  core.setOutput("ref", context.sha);
  core.setOutput("publish", String(publish));
  if (context.eventName === "schedule" && enabled !== "1") {
    core.setOutput("build", "false");
    core.notice("Scheduled nightly publishing is not enabled.");
    return;
  }
  const { data: stable } = await github.rest.repos.getLatestRelease(context.repo);
  if (!/^v\d+\.\d+\.\d+$/.test(stable.tag_name) || stable.prerelease || stable.draft)
    throw new Error("Expected a published stable baseline.");
  core.setOutput("stable_version", stable.tag_name.slice(1));
  if (context.eventName === "schedule") {
    const releases = await github.paginate(github.rest.repos.listReleases, {
      ...context.repo,
      per_page: 100,
    });
    const latest = releases
      .filter((r) => r.prerelease && !r.draft && NIGHTLY_TAG.test(r.tag_name))
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
    if (latest) {
      const { data: commit } = await github.rest.repos.getCommit({
        ...context.repo,
        ref: latest.tag_name,
      });
      if (commit.sha === context.sha) {
        core.setOutput("build", "false");
        core.notice("No source changes since the last successful nightly.");
        return;
      }
    }
  }
  core.setOutput("build", "true");
}

module.exports = { NIGHTLY_TAG, assertNightlyPublication, resolveNightly };
