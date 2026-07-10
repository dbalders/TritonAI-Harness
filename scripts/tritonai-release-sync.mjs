#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const DEFAULT_PARENT_REPO = "pingdotgg/t3code";
const DEFAULT_PARENT_REMOTE = "t3code-upstream";
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

function validateRemoteName(remote, role) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote)) {
    throw new Error(`Unsafe ${role} remote name: ${remote}`);
  }
}

function remoteExists(remote, cwd) {
  return gitStatus(["remote", "get-url", remote], { cwd }).status === 0;
}

function ensureFetchOnlyRemote(remote, url, downstreamRemote, cwd) {
  validateRemoteName(remote, "parent");
  validateRemoteName(downstreamRemote, "downstream");
  if (remote === downstreamRemote) {
    throw new Error(
      `Parent remote ${remote} must be separate from downstream remote ${downstreamRemote}.`,
    );
  }

  if (remoteExists(downstreamRemote, cwd)) {
    const downstreamUrls = git(["remote", "get-url", "--all", downstreamRemote], {
      cwd,
    }).split("\n");
    if (downstreamUrls.includes(url)) {
      throw new Error(
        `Parent fetch URL ${url} must not also be configured on downstream remote ${downstreamRemote}.`,
      );
    }
  }

  if (!remoteExists(remote, cwd)) {
    run("git", ["remote", "add", remote, url], { cwd });
  } else {
    const configuredUrls = git(["remote", "get-url", "--all", remote], { cwd }).split("\n");
    if (configuredUrls.length !== 1 || configuredUrls[0] !== url) {
      throw new Error(
        `Refusing parent remote ${remote}: expected only fetch URL ${url}, found ${configuredUrls.join(", ")}.`,
      );
    }
  }

  run("git", ["config", "--unset-all", `remote.${remote}.pushurl`], { cwd, check: false });
  run("git", ["config", "--add", `remote.${remote}.pushurl`, "DISABLED"], { cwd });
  const fetchUrls = git(["remote", "get-url", "--all", remote], { cwd }).split("\n");
  const pushUrls = git(["remote", "get-url", "--push", "--all", remote], { cwd }).split("\n");
  if (
    fetchUrls.length !== 1 ||
    fetchUrls[0] !== url ||
    pushUrls.length !== 1 ||
    pushUrls[0] !== "DISABLED"
  ) {
    throw new Error(`Parent remote ${remote} is not the verified fetch-only boundary.`);
  }
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
      "number,title,body,headRefName,baseRefName,labels,url,updatedAt,isDraft",
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

function mergeRelease({ releaseSha, worktree }) {
  return gitStatus(["merge", "--no-edit", releaseSha], { cwd: worktree }).status === 0
    ? "clean"
    : "conflicted";
}

function labelsFor(report) {
  const labels = [SYNC_LABEL];
  if (report.status === "needs-human-review") labels.push("needs review");
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
- Review: \`${report.reviewStatus}\`

${report.summary}

## Review Notes

- Preserve downstream TritonAI Harness branding and release-control behavior.
- Resolve and review every merge conflict manually before merging.

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
  const url = result.stdout.trim();
  const draftResult = run(
    "gh",
    ["pr", "view", branch, "--repo", repo, "--json", "isDraft", "--jq", ".isDraft"],
    { cwd, capture: true, check: false },
  );
  if (draftResult.status !== 0 || draftResult.stdout.trim() !== "false") {
    throw new Error("Created PR could not be verified as ready for review (isDraft=false).");
  }
  return url;
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function conflictEvidence(worktree) {
  const files = git(["diff", "--name-only", "--diff-filter=U"], { cwd: worktree });
  const stages = git(["ls-files", "--unmerged"], { cwd: worktree });
  return {
    files: files ? files.split("\n") : [],
    stages: stages ? stages.split("\n") : [],
    workingTreeHashes: Object.fromEntries(
      (files ? files.split("\n") : []).map((file) => {
        const path = NodePath.join(worktree, file);
        return [
          file,
          NodeFS.existsSync(path)
            ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex")
            : "missing",
        ];
      }),
    ),
  };
}

function cleanupAutomationWorktree({
  repoRoot,
  worktreeRoot,
  worktree,
  created,
  keepWorktree,
  expectedConflictEvidence,
}) {
  if (!created || !NodeFS.existsSync(worktree)) return true;
  if (keepWorktree) {
    console.error(`Kept sync worktree at ${worktree}`);
    return false;
  }

  const topLevel = gitStatus(["rev-parse", "--show-toplevel"], { cwd: worktree });
  if (
    topLevel.status !== 0 ||
    NodeFS.realpathSync(topLevel.stdout.trim()) !== NodeFS.realpathSync(worktree)
  ) {
    console.error(`Kept unverified sync worktree at ${worktree}`);
    return false;
  }

  const mergeInProgress = gitStatus(["rev-parse", "--verify", "-q", "MERGE_HEAD"], {
    cwd: worktree,
  });
  if (mergeInProgress.status === 0) {
    if (
      !expectedConflictEvidence ||
      JSON.stringify(conflictEvidence(worktree)) !== JSON.stringify(expectedConflictEvidence)
    ) {
      console.error(`Kept changed conflict worktree at ${worktree}; refusing to delete user work.`);
      return false;
    }
    const abortResult = gitStatus(["merge", "--abort"], { cwd: worktree });
    if (abortResult.status !== 0) {
      console.error(`Could not abort conflicted merge at ${worktree}; the worktree was preserved.`);
      return false;
    }
  }

  const status = gitStatus(["status", "--porcelain"], { cwd: worktree });
  if (status.status !== 0 || status.stdout.trim()) {
    console.error(`Kept dirty sync worktree at ${worktree}; refusing to delete user work.`);
    return false;
  }

  const removed = gitStatus(["worktree", "remove", worktree], { cwd: repoRoot });
  if (removed.status !== 0) {
    console.error(`Could not safely remove sync worktree at ${worktree}; it was preserved.`);
    return false;
  }
  NodeFS.rmSync(worktreeRoot, { recursive: true, force: true });
  return true;
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
  const checksConfigured = checks.trim().length > 0;
  const repo = originRepo(repoRoot);

  ensureFetchOnlyRemote(parentRemote, parentUrl, downstreamRemote, repoRoot);
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
    if (releasePr.isDraft === true) {
      throw new Error(
        `Existing release sync PR ${releasePr.url} is a draft; human action required.`,
      );
    }
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

  const branch = `${syncBranchPrefix}${releaseTag}-${releaseSha.slice(0, 12)}-${nowStamp()}`;
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
    checkStatus: args.skipChecks ? "skipped" : checksConfigured ? "not-run" : "not-configured",
    reviewStatus: "not-configured",
    summary: "",
  };
  let expectedConflictEvidence = null;
  let worktreeCreated = false;

  try {
    run("git", ["worktree", "add", "--detach", worktree, downstreamRef], { cwd: repoRoot });
    worktreeCreated = true;

    report.mergeStatus = mergeRelease({ releaseSha, worktree });
    if (report.mergeStatus === "conflicted") {
      report.summary = "Parent release merge has unresolved conflicts requiring human review.";
      expectedConflictEvidence = conflictEvidence(worktree);
      report.conflictEvidence = expectedConflictEvidence;
      console.log(JSON.stringify(report, null, 2));
      return 2;
    }

    if (!args.skipChecks && checksConfigured) {
      const checkResult = shell(checks, { cwd: worktree, check: false });
      report.checkStatus = checkResult.status === 0 ? "passed" : "failed";
    }

    report.status = "needs-human-review";
    report.summary =
      report.checkStatus === "passed"
        ? "Parent release merged cleanly and checks passed; human review is still required."
        : "Parent release merged cleanly, but checks did not pass; human review is required.";

    const labels = labelsFor(report);
    if (args.push) {
      run("git", ["push", downstreamRemote, `HEAD:refs/heads/${branch}`], {
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
    return 2;
  } finally {
    if (
      cleanupAutomationWorktree({
        repoRoot,
        worktreeRoot,
        worktree,
        created: worktreeCreated,
        keepWorktree: args.keepWorktree,
        expectedConflictEvidence,
      }) &&
      NodeFS.existsSync(worktreeRoot)
    ) {
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
