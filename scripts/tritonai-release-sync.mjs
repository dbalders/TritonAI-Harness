#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const DEFAULT_PARENT_REPO = "pingdotgg/t3code";
const DEFAULT_PARENT_REMOTE = "upstream";
const DEFAULT_PARENT_URL = "https://github.com/pingdotgg/t3code.git";
const DEFAULT_DOWNSTREAM_REMOTE = "origin";
const DEFAULT_DOWNSTREAM_BRANCH = "main";
const DEFAULT_SYNC_BRANCH_PREFIX = "sync/release-";
const DEFAULT_CHECKS = "vp check && vp run typecheck";
const SYNC_LABEL = "automation:release-sync";

function parseArgs(args) {
  const parsed = {
    push: false,
    createPr: false,
    skipChecks: false,
    keepWorktree: false,
  };

  for (const arg of args) {
    switch (arg) {
      case "--push":
        parsed.push = true;
        break;
      case "--create-pr":
        parsed.createPr = true;
        parsed.push = true;
        break;
      case "--skip-checks":
        parsed.skipChecks = true;
        break;
      case "--keep-worktree":
        parsed.keepWorktree = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/tritonai-release-sync.mjs [options]

Options:
  --push          Push the generated or reused sync branch.
  --create-pr     Push and open a GitHub PR when needed.
  --skip-checks   Skip TRITONAI_RELEASE_SYNC_CHECKS.
  --keep-worktree Keep the temporary worktree for inspection.

Environment:
  TRITONAI_RELEASE_SYNC_PARENT_REPO          Parent GitHub repo, default ${DEFAULT_PARENT_REPO}
  TRITONAI_RELEASE_SYNC_PARENT_REMOTE        Parent remote, default ${DEFAULT_PARENT_REMOTE}
  TRITONAI_RELEASE_SYNC_PARENT_URL           Parent remote URL, default ${DEFAULT_PARENT_URL}
  TRITONAI_RELEASE_SYNC_DOWNSTREAM_BRANCH    Target branch, default ${DEFAULT_DOWNSTREAM_BRANCH}
  TRITONAI_RELEASE_SYNC_CHECKS               Shell checks, default "${DEFAULT_CHECKS}"
`);
}

function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (options.check !== false && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

function capture(command, args, options = {}) {
  const result = run(command, args, { ...options, capture: true });
  return result.stdout.trim();
}

function git(args, options = {}) {
  return capture("git", args, options);
}

function gitStatus(args, options = {}) {
  return run("git", args, { ...options, capture: true, check: false });
}

function gh(args, options = {}) {
  return capture("gh", args, options);
}

function shell(command, options = {}) {
  return run(command, [], { ...options, shell: true });
}

function remoteExists(remote, cwd) {
  return gitStatus(["remote", "get-url", remote], { cwd }).status === 0;
}

function ensureRemote(remote, url, cwd) {
  if (!remoteExists(remote, cwd)) {
    run("git", ["remote", "add", remote, url], { cwd });
  }
  run("git", ["remote", "set-url", remote, url], { cwd });
}

function fetchRemoteBranch(remote, branch, cwd) {
  run(
    "git",
    ["fetch", "--prune", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    { cwd },
  );
}

function isAncestor(ancestor, descendant, cwd) {
  return gitStatus(["merge-base", "--is-ancestor", ancestor, descendant], { cwd }).status === 0;
}

function parseJsonLines(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function latestStableRelease(parentRepo, cwd) {
  const raw = gh(
    [
      "release",
      "list",
      "--repo",
      parentRepo,
      "--limit",
      "50",
      "--json",
      "tagName,name,isPrerelease,isDraft,publishedAt",
      "--jq",
      ".[] | select(.isDraft == false and .isPrerelease == false) | @json",
    ],
    { cwd },
  );
  const [release] = parseJsonLines(raw);
  if (!release) {
    throw new Error(`No non-prerelease GitHub releases found for ${parentRepo}.`);
  }
  return release;
}

function originRepo(cwd) {
  const configured = process.env.TRITONAI_RELEASE_SYNC_GITHUB_REPO ?? process.env.GH_REPO;
  if (configured) return configured;

  const url = git(["remote", "get-url", "origin"], { cwd });
  const match = url.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/u);
  if (!match) {
    throw new Error("Could not infer GitHub repo from origin remote; set GH_REPO.");
  }
  return match[1];
}

function openSyncPrs({ repo, syncBranchPrefix, cwd }) {
  const raw = gh(
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,title,body,headRefName,baseRefName,labels,url,updatedAt",
      "--jq",
      `.[] | select((.labels // [] | map(.name) | index("${SYNC_LABEL}")) or (.headRefName | startswith("${syncBranchPrefix}"))) | @json`,
    ],
    { cwd },
  );
  return parseJsonLines(raw);
}

function prRecordsRelease(pr, releaseTag, releaseSha) {
  const fields = [pr.title, pr.body, pr.headRefName].filter(Boolean).join("\n");
  return fields.includes(releaseTag) || fields.includes(releaseSha);
}

function createWorktree({ branch, downstreamRef, worktree, cwd }) {
  run("git", ["worktree", "add", "-b", branch, worktree, downstreamRef], { cwd });
}

function mergeRelease({ releaseSha, worktree }) {
  const cleanMerge = gitStatus(["merge", "--no-edit", releaseSha], { cwd: worktree });
  if (cleanMerge.status === 0) return "clean";

  run("git", ["merge", "--abort"], { cwd: worktree, check: false });
  const oursMerge = gitStatus(["merge", "--no-edit", "-X", "ours", releaseSha], { cwd: worktree });
  if (oursMerge.status === 0) return "conflict-auto-resolved-with-downstream";

  return "conflicted";
}

function labelsFor(report) {
  const labels = [SYNC_LABEL];
  if (report.status === "needs-human-review") labels.push("needs-human-review");
  if (report.mergeStatus !== "clean") labels.push("upstream-conflict");
  if (report.checkStatus === "failed") labels.push("checks-failed");
  return [...new Set(labels)];
}

function buildPrBody(report, labels) {
  return `## TritonAI Harness Parent Release Sync

This PR was generated by \`scripts/tritonai-release-sync.mjs\`.

## Summary

- Parent release: \`${report.releaseTag}\` @ \`${report.releaseSha}\`
- Published: \`${report.releasePublishedAt}\`
- Downstream: \`${report.downstreamBranch}\` @ \`${report.downstreamSha}\`
- Result: \`${report.status}\`
- Merge: \`${report.mergeStatus}\`
- Checks: \`${report.checkStatus}\`

${report.summary}

## Review Notes

- Preserve downstream TritonAI Harness branding and release-control behavior.
- Review any \`-X ours\` conflict resolutions before merging.

## Labels

${labels.map((label) => `- \`${label}\``).join("\n")}
`;
}

function createOrUpdatePullRequest({ repo, pr, branch, baseBranch, title, body, labels, cwd }) {
  if (pr) {
    const args = [
      "pr",
      "edit",
      String(pr.number),
      "--repo",
      repo,
      "--title",
      title,
      "--body",
      body,
    ];
    for (const label of labels) {
      args.push("--add-label", label);
    }
    run("gh", args, { cwd });
    return pr.url;
  }

  const args = [
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    baseBranch,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ];
  for (const label of labels) {
    args.push("--label", label);
  }
  const result = run("gh", args, { cwd, capture: true });
  return result.stdout.trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  const parentRepo = process.env.TRITONAI_RELEASE_SYNC_PARENT_REPO ?? DEFAULT_PARENT_REPO;
  const parentRemote = process.env.TRITONAI_RELEASE_SYNC_PARENT_REMOTE ?? DEFAULT_PARENT_REMOTE;
  const parentUrl = process.env.TRITONAI_RELEASE_SYNC_PARENT_URL ?? DEFAULT_PARENT_URL;
  const downstreamRemote =
    process.env.TRITONAI_RELEASE_SYNC_DOWNSTREAM_REMOTE ?? DEFAULT_DOWNSTREAM_REMOTE;
  const downstreamBranch =
    process.env.TRITONAI_RELEASE_SYNC_DOWNSTREAM_BRANCH ?? DEFAULT_DOWNSTREAM_BRANCH;
  const syncBranchPrefix =
    process.env.TRITONAI_RELEASE_SYNC_BRANCH_PREFIX ?? DEFAULT_SYNC_BRANCH_PREFIX;
  const checks = process.env.TRITONAI_RELEASE_SYNC_CHECKS ?? DEFAULT_CHECKS;
  const repo = originRepo(repoRoot);

  ensureRemote(parentRemote, parentUrl, repoRoot);
  run("git", ["fetch", parentRemote, "--tags", "--prune"], { cwd: repoRoot });
  fetchRemoteBranch(downstreamRemote, downstreamBranch, repoRoot);

  const release = latestStableRelease(parentRepo, repoRoot);
  const releaseTag = String(release.tagName);
  const releaseSha = git(["rev-list", "-n", "1", releaseTag], { cwd: repoRoot });
  const downstreamRef = `${downstreamRemote}/${downstreamBranch}`;
  const downstreamSha = git(["rev-parse", downstreamRef], { cwd: repoRoot });
  const prs = openSyncPrs({ repo, syncBranchPrefix, cwd: repoRoot });
  const releasePr = prs.find((pr) => prRecordsRelease(pr, releaseTag, releaseSha));

  if (isAncestor(releaseSha, downstreamRef, repoRoot)) {
    const result = {
      status: "already-current",
      releaseTag,
      releaseSha,
      downstreamBranch,
      downstreamSha,
      existingPr: releasePr?.url ?? null,
    };
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (releasePr) {
    const result = {
      status: "open-pr-already-records-release",
      releaseTag,
      releaseSha,
      downstreamBranch,
      downstreamSha,
      pr: releasePr.url,
      branch: releasePr.headRefName,
    };
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const branch = `${syncBranchPrefix}${releaseTag}-${releaseSha.slice(0, 12)}`;
  const worktreeRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tritonai-release-sync-"));
  const worktree = NodePath.join(worktreeRoot, "worktree");
  const report = {
    status: "needs-human-review",
    releaseTag,
    releaseSha,
    releasePublishedAt: release.publishedAt,
    downstreamBranch,
    downstreamSha,
    syncBranch: branch,
    mergeStatus: "not-run",
    checkStatus: args.skipChecks ? "skipped" : "not-run",
    summary: "",
  };

  try {
    createWorktree({ branch, downstreamRef, worktree, cwd: repoRoot });

    report.mergeStatus = mergeRelease({ releaseSha, worktree });
    if (report.mergeStatus === "conflicted") {
      report.summary =
        "Parent release merge still has unresolved conflicts after retrying with downstream conflict preference.";
      console.log(JSON.stringify(report, null, 2));
      return 2;
    }

    if (!args.skipChecks) {
      const checkResult = shell(checks, { cwd: worktree, check: false });
      report.checkStatus = checkResult.status === 0 ? "passed" : "failed";
    }

    const checksOk = report.checkStatus === "passed" || report.checkStatus === "skipped";
    report.status =
      report.mergeStatus === "clean" && checksOk ? "review-ready" : "needs-human-review";
    report.summary =
      report.mergeStatus === "clean"
        ? "Parent release merged cleanly into TritonAI Harness."
        : "Parent release was merged with downstream-preferred conflict resolutions.";

    const labels = labelsFor(report);
    if (args.push) {
      run("git", ["push", downstreamRemote, `${branch}:${branch}`, "--force-with-lease"], {
        cwd: worktree,
      });
    }

    let prUrl = null;
    if (args.createPr) {
      prUrl = createOrUpdatePullRequest({
        repo,
        pr: null,
        branch,
        baseBranch: downstreamBranch,
        title: `Review release sync: ${releaseTag}`,
        body: buildPrBody(report, labels),
        labels,
        cwd: worktree,
      });
    }

    console.log(JSON.stringify({ ...report, labels, pr: prUrl }, null, 2));
    return report.status === "review-ready" ? 0 : 2;
  } finally {
    if (args.keepWorktree) {
      console.error(`Kept sync worktree at ${worktree}`);
    } else if (NodeFS.existsSync(worktreeRoot)) {
      run("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot, check: false });
      NodeFS.rmSync(worktreeRoot, { recursive: true, force: true });
    }
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
