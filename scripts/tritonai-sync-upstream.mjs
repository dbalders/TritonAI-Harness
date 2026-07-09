#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const DEFAULT_UPSTREAM_REMOTE = "upstream";
const DEFAULT_UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";
const DEFAULT_UPSTREAM_BRANCH = "main";
const DEFAULT_DOWNSTREAM_REMOTE = "origin";
const DEFAULT_DOWNSTREAM_BRANCH = "main";
const DEFAULT_SYNC_BRANCH_PREFIX = "sync/upstream-";
const DEFAULT_CHECKS = "bun run typecheck && bun run test";
const DEFAULT_SECRET_ALLOWLIST = "CODEX_HOME,TRITONAI_HOME,TRITONAI_API_KEY";

function parseArgs(args) {
  const parsed = {
    push: false,
    createPr: false,
    autoMergePr: false,
    keepWorktree: false,
    skipChecks: false,
    noLlm: false,
    allowNeedsReview: false,
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
      case "--auto-merge-pr":
        parsed.autoMergePr = true;
        parsed.createPr = true;
        parsed.push = true;
        break;
      case "--keep-worktree":
        parsed.keepWorktree = true;
        break;
      case "--skip-checks":
        parsed.skipChecks = true;
        break;
      case "--no-llm":
        parsed.noLlm = true;
        break;
      case "--allow-needs-review":
        parsed.allowNeedsReview = true;
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
  console.log(`Usage: node scripts/tritonai-sync-upstream.mjs [options]

Options:
  --push              Push the generated sync branch.
  --create-pr         Push and open a GitHub PR.
  --auto-merge-pr     Merge an auto-merge-ready PR.
  --keep-worktree     Keep the temporary worktree for inspection.
  --skip-checks       Skip TRITONAI_SYNC_CHECKS.
  --no-llm            Do not run the Codex/agent review command.
  --allow-needs-review
                      Exit 0 even when the result needs human review.

Environment:
  TRITONAI_SYNC_DOWNSTREAM_BRANCH   Target branch, default ${DEFAULT_DOWNSTREAM_BRANCH}
  TRITONAI_SYNC_UPSTREAM_URL        Upstream repo, default ${DEFAULT_UPSTREAM_URL}
  TRITONAI_SYNC_UPSTREAM_BRANCH     Upstream branch, default ${DEFAULT_UPSTREAM_BRANCH}
  TRITONAI_SYNC_CHECKS              Shell checks, default "${DEFAULT_CHECKS}"
  TRITONAI_SYNC_AGENT_COMMAND       Codex/agent review command.
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
  return NodeChildProcess.execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(args, options = {}) {
  return capture("git", args, options);
}

function gitStatus(args, options = {}) {
  return run("git", args, { ...options, capture: true, check: false });
}

function remoteExists(remote, cwd) {
  const result = gitStatus(["remote", "get-url", remote], { cwd });
  return result.status === 0;
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

function parseCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isSecretEnvName(name) {
  return /(token|password|passwd|secret|credential|cookie|session|api.?key|auth|litellm|openai|anthropic|github|gh_token)/iu.test(
    name,
  );
}

function makeSanitizedEnv({ sourceEnv = process.env, allowSecretNames = [], extra = {} } = {}) {
  const allow = new Set(allowSecretNames);
  const next = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (isSecretEnvName(key) && !allow.has(key)) continue;
    next[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/u, "Z");
}

function shell(command, options = {}) {
  return run(command, [], { ...options, shell: true });
}

function readJsonObject(file) {
  const raw = NodeFS.readFileSync(file, "utf8").trim();
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${file}`);
  }
  return parsed;
}

function reportLabels(report) {
  const labels = ["automation:upstream-sync"];
  if (
    report.status === "needs-human-review" ||
    report.reviewStatus === "risk" ||
    report.reviewStatus === "not-configured"
  ) {
    labels.push("needs review");
  }
  if (report.mergeStatus === "conflicted") labels.push("upstream-conflict");
  if (report.checkStatus === "failed") labels.push("checks-failed");
  return [...new Set(labels)];
}

function buildPrBody(report, labels) {
  const risks = Array.isArray(report.risks) ? report.risks : [];
  const riskLines = risks.length > 0 ? risks.map((risk) => `- ${risk}`).join("\n") : "- None";
  return `## TritonAI Harness Upstream Sync

This PR was generated by \`scripts/tritonai-sync-upstream.mjs\`.

## Summary

- Upstream: \`${report.upstreamRef}\` @ \`${report.upstreamSha}\`
- Downstream: \`${report.downstreamBranch}\` @ \`${report.downstreamSha}\`
- Result: \`${report.status}\`
- Merge: \`${report.mergeStatus}\`
- Checks: \`${report.checkStatus}\`
- Review: \`${report.reviewStatus}\`

${report.summary ?? "No additional summary was provided."}

## Risks

${riskLines}

## Labels

${labels.map((label) => `- \`${label}\``).join("\n")}
`;
}

function runAgentReview({ worktree, report, allowSecretNames }) {
  const command = process.env.TRITONAI_SYNC_AGENT_COMMAND;
  if (!command) {
    return {
      reviewStatus: "not-configured",
      autoMerge: false,
      reason: "TRITONAI_SYNC_AGENT_COMMAND is not set.",
      summary: "No Codex review command was configured.",
      risks: ["Run manual review or configure TRITONAI_SYNC_AGENT_COMMAND."],
      agentAttempted: false,
    };
  }

  const syncDir = NodePath.join(worktree, ".tritonai-sync");
  NodeFS.mkdirSync(syncDir, { recursive: true });
  const promptFile = NodePath.join(syncDir, "agent-prompt.md");
  const responseFile = NodePath.join(syncDir, "agent-response.json");
  NodeFS.writeFileSync(
    promptFile,
    `You are reviewing an upstream sync into TritonAI Harness.

TritonAI Harness is Codex-first. Do not reintroduce non-Codex runtime assumptions, provider update prompts, or public multi-provider defaults.

Review the worktree at:
${worktree}

Return only JSON with:
{
  "auto_merge": boolean,
  "reason": "short reason",
  "summary": "what happened",
  "risks": ["risk or follow-up"]
}

Current automation report:
${JSON.stringify(report, null, 2)}
`,
  );
  NodeFS.writeFileSync(responseFile, "");

  const env = makeSanitizedEnv({
    allowSecretNames,
    extra: {
      TRITONAI_SYNC_AGENT_PHASE: "merge-review",
      TRITONAI_SYNC_AGENT_PROMPT_FILE: promptFile,
      TRITONAI_SYNC_AGENT_RESPONSE_FILE: responseFile,
      TRITONAI_SYNC_AGENT_CAN_EDIT: process.env.TRITONAI_SYNC_AGENT_CAN_EDIT ?? "0",
    },
  });
  const result = shell(command, { cwd: worktree, env, check: false });
  if (result.status !== 0) {
    return {
      reviewStatus: "failed",
      autoMerge: false,
      reason: `Agent command exited with ${result.status}.`,
      summary: "Codex review command failed.",
      risks: ["Manual review required because the configured review command failed."],
      agentAttempted: true,
    };
  }

  const parsed = readJsonObject(responseFile);
  return {
    reviewStatus: parsed?.auto_merge === true ? "approved" : "risk",
    autoMerge: parsed?.auto_merge === true,
    reason: String(parsed?.reason ?? ""),
    summary: String(parsed?.summary ?? ""),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String) : [],
    agentAttempted: true,
  };
}

function createPullRequest({ branch, title, body, labels, cwd }) {
  const args = ["pr", "create", "--head", branch, "--title", title, "--body", body];
  const repo = process.env.TRITONAI_SYNC_GITHUB_REPO ?? process.env.GH_REPO;
  if (repo) {
    args.push("--repo", repo);
  }
  for (const label of labels) {
    args.push("--label", label);
  }
  const result = run("gh", args, { cwd, check: false });
  if (result.status !== 0) {
    throw new Error("gh pr create failed. The PR may already exist.");
  }
}

function autoMergePullRequest({ branch, cwd }) {
  const repo = process.env.TRITONAI_SYNC_GITHUB_REPO ?? process.env.GH_REPO;
  const method = process.env.TRITONAI_SYNC_PR_MERGE_METHOD ?? "merge";
  const args = ["pr", "merge", branch, `--${method}`, "--delete-branch"];
  if (repo) {
    args.push("--repo", repo);
  }
  run("gh", args, { cwd });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = git(["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  const upstreamRemote = process.env.TRITONAI_SYNC_UPSTREAM_REMOTE ?? DEFAULT_UPSTREAM_REMOTE;
  const upstreamUrl = process.env.TRITONAI_SYNC_UPSTREAM_URL ?? DEFAULT_UPSTREAM_URL;
  const upstreamBranch = process.env.TRITONAI_SYNC_UPSTREAM_BRANCH ?? DEFAULT_UPSTREAM_BRANCH;
  const downstreamRemote = process.env.TRITONAI_SYNC_DOWNSTREAM_REMOTE ?? DEFAULT_DOWNSTREAM_REMOTE;
  const downstreamBranch = process.env.TRITONAI_SYNC_DOWNSTREAM_BRANCH ?? DEFAULT_DOWNSTREAM_BRANCH;
  const syncBranchPrefix = process.env.TRITONAI_SYNC_BRANCH_PREFIX ?? DEFAULT_SYNC_BRANCH_PREFIX;
  const checks = process.env.TRITONAI_SYNC_CHECKS ?? DEFAULT_CHECKS;
  const allowSecretNames = parseCsv(
    process.env.TRITONAI_SYNC_AGENT_SECRET_ENV_ALLOWLIST ?? DEFAULT_SECRET_ALLOWLIST,
  );

  ensureRemote(upstreamRemote, upstreamUrl, repoRoot);
  fetchRemoteBranch(upstreamRemote, upstreamBranch, repoRoot);
  fetchRemoteBranch(downstreamRemote, downstreamBranch, repoRoot);

  const upstreamRef = `${upstreamRemote}/${upstreamBranch}`;
  const downstreamRef = `${downstreamRemote}/${downstreamBranch}`;
  const upstreamSha = git(["rev-parse", upstreamRef], { cwd: repoRoot });
  const downstreamSha = git(["rev-parse", downstreamRef], { cwd: repoRoot });

  if (isAncestor(upstreamSha, downstreamSha, repoRoot)) {
    console.log(
      JSON.stringify(
        {
          status: "already-current",
          upstreamRef,
          upstreamSha,
          downstreamBranch,
          downstreamSha,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const branch = `${syncBranchPrefix}${nowStamp()}-${upstreamSha.slice(0, 12)}`;
  const worktreeRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tritonai-sync-"));
  const worktree = NodePath.join(worktreeRoot, "worktree");
  const report = {
    status: "needs-human-review",
    upstreamRef,
    upstreamSha,
    downstreamBranch,
    downstreamSha,
    syncBranch: branch,
    mergeStatus: "not-run",
    checkStatus: args.skipChecks ? "skipped" : "not-run",
    reviewStatus: args.noLlm ? "skipped" : "not-run",
    summary: "",
    risks: [],
    agentAttempted: false,
  };

  try {
    run("git", ["worktree", "add", "-b", branch, worktree, downstreamRef], { cwd: repoRoot });
    const mergeResult = gitStatus(["merge", "--no-edit", upstreamSha], { cwd: worktree });
    report.mergeStatus = mergeResult.status === 0 ? "clean" : "conflicted";

    if (mergeResult.status !== 0) {
      report.summary = "Upstream merge produced conflicts.";
      report.risks = ["Resolve merge conflicts before merging upstream changes."];
      console.log(JSON.stringify(report, null, 2));
      return args.allowNeedsReview ? 0 : 2;
    }

    if (!args.skipChecks) {
      const checkEnv = makeSanitizedEnv({ allowSecretNames: [] });
      const checkResult = shell(checks, { cwd: worktree, env: checkEnv, check: false });
      report.checkStatus = checkResult.status === 0 ? "passed" : "failed";
      if (checkResult.status !== 0) {
        report.summary = "Merge completed, but validation checks failed.";
        report.risks = ["Fix failing validation before merging."];
      }
    }

    if (!args.noLlm) {
      const review = runAgentReview({ worktree, report, allowSecretNames });
      report.reviewStatus = review.reviewStatus;
      report.agentAttempted = review.agentAttempted;
      report.summary = review.summary || report.summary;
      report.risks = review.risks.length > 0 ? review.risks : report.risks;
      report.reviewReason = review.reason;
    }

    const checksOk = report.checkStatus === "passed" || report.checkStatus === "skipped";
    const reviewOk = report.reviewStatus === "approved" || report.reviewStatus === "skipped";
    if (report.mergeStatus === "clean" && checksOk && reviewOk) {
      report.status = "auto-merge-ready";
    }

    const labels = reportLabels(report);
    if (args.push) {
      run("git", ["push", downstreamRemote, `${branch}:${branch}`, "--force-with-lease"], {
        cwd: worktree,
      });
    }
    if (args.createPr) {
      createPullRequest({
        branch,
        cwd: worktree,
        labels,
        title: `Sync upstream ${upstreamBranch} into ${downstreamBranch}`,
        body: buildPrBody(report, labels),
      });
    }
    if (args.autoMergePr && report.status === "auto-merge-ready") {
      autoMergePullRequest({ branch, cwd: worktree });
    }

    console.log(JSON.stringify({ ...report, labels }, null, 2));
    return report.status === "auto-merge-ready" || args.allowNeedsReview ? 0 : 2;
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
