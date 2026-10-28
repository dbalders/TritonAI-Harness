import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off - exercises the real sync script with local Git worktrees.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const syncScript = NodePath.resolve(repoRoot, "scripts/tritonai-sync-upstream.mjs");
const releaseScript = NodePath.resolve(repoRoot, "scripts/tritonai-release-sync.mjs");

interface Fixture {
  readonly fakeBin: string;
  readonly repo: string;
  readonly root: string;
  readonly trace: string;
  readonly upstream: string;
}

interface InstallTrace {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly hadNodeModules: boolean;
  readonly lockfileIsUpstream: boolean;
  readonly packageIsUpstream: boolean;
  readonly agentCommandWasPresent: boolean;
  readonly awsKeyWasPresent: boolean;
  readonly home: string;
  readonly secretWasPresent: boolean;
}

interface CommandTrace {
  readonly cwd: string;
}

function git(cwd: string, ...args: ReadonlyArray<string>): void {
  NodeChildProcess.execFileSync("git", args, { cwd, stdio: "ignore" });
}

function writeExecutable(path: string, source: string): void {
  NodeFS.writeFileSync(path, source);
  NodeFS.chmodSync(path, 0o755);
}

function createFixture(): Fixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tritonai-sync-test-"));
  const origin = NodePath.join(root, "origin.git");
  const upstream = NodePath.join(root, "upstream.git");
  const repo = NodePath.join(root, "repo");
  const fakeBin = NodePath.join(root, "bin");
  const trace = NodePath.join(root, "trace");

  NodeFS.mkdirSync(fakeBin);
  NodeFS.mkdirSync(trace);
  git(root, "init", "--bare", origin);
  git(root, "init", "--bare", upstream);
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.name", "TritonAI Sync Test");
  git(repo, "config", "user.email", "sync-test@example.invalid");
  git(repo, "config", "commit.gpgSign", "false");

  NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), "node_modules/\n");
  NodeFS.writeFileSync(
    NodePath.join(repo, "package.json"),
    `${JSON.stringify({ name: "sync-fixture", packageManager: "pnpm@11.10.0", revision: "base" }, null, 2)}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(repo, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nrevision: base\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fixture base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "remote", "add", "upstream", upstream);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "push", "upstream", "main");

  git(repo, "switch", "-c", "upstream-fixture");
  NodeFS.writeFileSync(
    NodePath.join(repo, "package.json"),
    `${JSON.stringify(
      { name: "sync-fixture", packageManager: "pnpm@11.10.0", revision: "upstream" },
      null,
      2,
    )}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(repo, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nrevision: upstream\n",
  );
  git(repo, "add", "package.json", "pnpm-lock.yaml");
  git(repo, "commit", "-m", "fixture upstream change");
  git(repo, "push", "upstream", "HEAD:main");
  git(repo, "switch", "main");

  writeExecutable(
    NodePath.join(fakeBin, "vp"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const trace = path.join(path.dirname(__filename), "..", "trace");
const cwd = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
const lockfile = fs.readFileSync(path.join(cwd, "pnpm-lock.yaml"), "utf8");
const record = {
  args: process.argv.slice(2),
  cwd,
  hadNodeModules: fs.existsSync(path.join(cwd, "node_modules")),
  lockfileIsUpstream: lockfile.includes("revision: upstream"),
  packageIsUpstream: packageJson.revision === "upstream",
  agentCommandWasPresent: Object.hasOwn(process.env, "TRITONAI_SYNC_AGENT_COMMAND"),
  awsKeyWasPresent: Object.hasOwn(process.env, "AWS_ACCESS_KEY_ID"),
  home: process.env.HOME,
  secretWasPresent: Object.hasOwn(process.env, "TEST_SENTINEL_SECRET"),
};
fs.writeFileSync(path.join(trace, "install.json"), JSON.stringify(record));
fs.appendFileSync(path.join(trace, "order"), "install\\n");
const expected = ["install", "--frozen-lockfile"];
if (JSON.stringify(record.args) !== JSON.stringify(expected) || record.hadNodeModules ||
    !record.lockfileIsUpstream || !record.packageIsUpstream || record.agentCommandWasPresent ||
    record.awsKeyWasPresent || record.secretWasPresent) {
  process.exit(91);
}
const requestedExit = Number(fs.readFileSync(path.join(trace, "install-exit"), "utf8"));
if (requestedExit !== 0) process.exit(requestedExit);
fs.mkdirSync(path.join(cwd, "node_modules"));
fs.writeFileSync(path.join(cwd, "node_modules", ".installed"), "installed\\n");
`,
  );

  writeExecutable(
    NodePath.join(fakeBin, "fixture-check"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
const trace = path.join(path.dirname(__filename), "..", "trace");
if (!fs.existsSync(path.join(cwd, "node_modules", ".installed")) ||
    Object.hasOwn(process.env, "TEST_SENTINEL_SECRET") ||
    Object.hasOwn(process.env, "TRITONAI_SYNC_AGENT_COMMAND") ||
    Object.hasOwn(process.env, "AWS_ACCESS_KEY_ID")) {
  process.exit(92);
}
fs.appendFileSync(path.join(trace, "order"), "checks\\n");
fs.writeFileSync(path.join(trace, "checks.json"), JSON.stringify({ cwd }));
fs.writeFileSync(path.join(cwd, ".checks-passed"), "passed\\n");
`,
  );

  writeExecutable(
    NodePath.join(fakeBin, "fixture-agent"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
const trace = path.join(path.dirname(__filename), "..", "trace");
if (!fs.existsSync(path.join(cwd, "node_modules", ".installed")) ||
    !fs.existsSync(path.join(cwd, ".checks-passed")) ||
    Object.hasOwn(process.env, "TEST_SENTINEL_SECRET")) {
  process.exit(93);
}
fs.appendFileSync(path.join(trace, "order"), "review\\n");
fs.writeFileSync(path.join(trace, "review.json"), JSON.stringify({ cwd }));
fs.writeFileSync(process.env.TRITONAI_SYNC_AGENT_RESPONSE_FILE, JSON.stringify({
  auto_merge: true,
  reason: "fixture approved",
  summary: "fixture approved",
  risks: [],
}));
`,
  );

  return { fakeBin, repo, root, trace, upstream };
}

function runSync(
  fixture: Fixture,
  installExit = 0,
  extraEnv: Record<string, string> = {},
  args: string[] = [],
) {
  NodeFS.writeFileSync(NodePath.join(fixture.trace, "install-exit"), String(installExit));
  return NodeChildProcess.spawnSync(process.execPath, [syncScript, ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      AWS_ACCESS_KEY_ID: "must-not-reach-merged-worktree-commands",
      PATH: `${fixture.fakeBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      TEST_SENTINEL_SECRET: "must-not-reach-merged-worktree-commands",
      TRITONAI_SYNC_AGENT_COMMAND: "fixture-agent",
      TRITONAI_SYNC_AGENT_SECRET_ENV_ALLOWLIST: "",
      TRITONAI_SYNC_CHECKS: "fixture-check",
      TRITONAI_SYNC_DOWNSTREAM_BRANCH: extraEnv.TRITONAI_SYNC_DOWNSTREAM_BRANCH ?? "main",
      TRITONAI_SYNC_DOWNSTREAM_REMOTE: "origin",
      TRITONAI_SYNC_UPSTREAM_BRANCH: "main",
      TRITONAI_SYNC_UPSTREAM_REMOTE: "upstream",
      TRITONAI_SYNC_UPSTREAM_URL: fixture.upstream,
    },
  });
}

// regression: 61d94a564b fix(tooling): isolate merged sync install
it("installs a clean merged worktree before checks and review", () => {
  const fixture = createFixture();
  try {
    assert.ok(!NodeFS.existsSync(NodePath.join(fixture.repo, "node_modules")));

    const result = runSync(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status": "auto-merge-ready"/u);
    assert.match(result.stdout, /"installStatus": "passed"/u);
    assert.match(result.stdout, /"checkStatus": "passed"/u);
    assert.match(result.stdout, /"reviewStatus": "approved"/u);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(fixture.trace, "order"), "utf8"),
      "install\nchecks\nreview\n",
    );

    const install = JSON.parse(
      NodeFS.readFileSync(NodePath.join(fixture.trace, "install.json"), "utf8"),
    ) as InstallTrace;
    assert.deepStrictEqual(install.args, ["install", "--frozen-lockfile"]);
    assert.equal(install.hadNodeModules, false);
    assert.equal(install.packageIsUpstream, true);
    assert.equal(install.lockfileIsUpstream, true);
    assert.equal(install.agentCommandWasPresent, false);
    assert.equal(install.awsKeyWasPresent, false);
    assert.equal(install.secretWasPresent, false);
    assert.notEqual(install.home, process.env.HOME);
    assert.equal(NodePath.basename(install.cwd), "worktree");
    assert.match(NodePath.basename(NodePath.dirname(install.cwd)), /^tritonai-sync-/u);
    assert.notEqual(NodePath.resolve(install.cwd), NodePath.resolve(fixture.repo));
    const checks = JSON.parse(
      NodeFS.readFileSync(NodePath.join(fixture.trace, "checks.json"), "utf8"),
    ) as CommandTrace;
    const review = JSON.parse(
      NodeFS.readFileSync(NodePath.join(fixture.trace, "review.json"), "utf8"),
    ) as CommandTrace;
    assert.equal(checks.cwd, install.cwd);
    assert.equal(review.cwd, install.cwd);
    assert.ok(!NodeFS.existsSync(install.cwd), "The temporary merged worktree should be removed.");
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe.each(Array.from(["squash", "rebase"], (scenario) => ({ scenario })))(
  "case $scenario",
  ({ scenario: method }) => {
    it(`refuses to run when the PR merge method is ${method}`, () => {
      const fixture = createFixture();
      try {
        const result = runSync(fixture, 0, { TRITONAI_SYNC_PR_MERGE_METHOD: method });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /squash and rebase are not allowed/u);
        assert.ok(!NodeFS.existsSync(NodePath.join(fixture.trace, "install.json")));
      } finally {
        NodeFS.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  },
);

// regression: 61d94a564b fix(tooling): isolate merged sync install
it("fails closed before checks and review when the merged worktree install fails", () => {
  const fixture = createFixture();
  try {
    const result = runSync(fixture, 42);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /"status": "needs-human-review"/u);
    assert.match(result.stdout, /"installStatus": "failed"/u);
    assert.match(result.stdout, /"checkStatus": "not-run"/u);
    assert.match(result.stdout, /"reviewStatus": "not-run"/u);
    assert.equal(NodeFS.readFileSync(NodePath.join(fixture.trace, "order"), "utf8"), "install\n");
    assert.ok(!NodeFS.existsSync(NodePath.join(fixture.trace, "checks.json")));
    assert.ok(!NodeFS.existsSync(NodePath.join(fixture.trace, "review.json")));
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function installFakeGithub(fixture: Fixture): void {
  writeExecutable(
    NodePath.join(fixture.fakeBin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const trace = path.join(path.dirname(__filename), "..", "trace");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(trace, "github.jsonl"), JSON.stringify(args) + "\\n");
if (args[0] === "release" && args[1] === "list") {
  console.log(JSON.stringify({tagName: "v9.9.9", publishedAt: "2026-10-16T00:00:00Z"}));
} else if (args[0] === "pr" && args[1] === "create") {
  console.log("https://github.com/fixture/harness/pull/1");
} else if (!(args[0] === "pr" && args[1] === "list")) {
  throw new Error("Unexpected fake GitHub operation");
}
`,
  );
}

function githubCalls(fixture: Fixture): string[][] {
  return NodeFS.readFileSync(NodePath.join(fixture.trace, "github.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
}

function runReleaseSync(fixture: Fixture, args: string[] = [], installExit = 0) {
  NodeFS.writeFileSync(NodePath.join(fixture.trace, "install-exit"), String(installExit));
  const env = { ...process.env };
  delete env.AWS_ACCESS_KEY_ID;
  delete env.TEST_SENTINEL_SECRET;
  delete env.TRITONAI_SYNC_AGENT_COMMAND;
  return NodeChildProcess.spawnSync(process.execPath, [releaseScript, ...args], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...env,
      PATH: `${fixture.fakeBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      TRITONAI_RELEASE_SYNC_PARENT_REPO: "fixture/parent",
      TRITONAI_RELEASE_SYNC_PARENT_URL: fixture.upstream,
      TRITONAI_RELEASE_SYNC_PARENT_REMOTE: "upstream",
      TRITONAI_RELEASE_SYNC_DOWNSTREAM_REMOTE: "origin",
      TRITONAI_RELEASE_SYNC_DOWNSTREAM_BRANCH: "main",
      TRITONAI_RELEASE_SYNC_GITHUB_REPO: "fixture/harness",
      TRITONAI_RELEASE_SYNC_CHECKS: "fixture-check",
    },
  });
}

function prepareReleaseFixture(fixture: Fixture): void {
  installFakeGithub(fixture);
  git(fixture.repo, "tag", "v9.9.9", "upstream-fixture");
  git(fixture.repo, "push", "upstream", "v9.9.9");
}

it("installs the frozen release candidate before checks and reuses it on a later PR attempt", () => {
  const fixture = createFixture();
  try {
    prepareReleaseFixture(fixture);
    const initial = runReleaseSync(fixture);
    assert.equal(initial.status, 0, initial.stderr);
    assert.match(initial.stdout, /"installStatus": "passed"/u);
    const branch = NodeChildProcess.execFileSync("git", ["branch", "--list", "sync/release-*"], {
      cwd: fixture.repo,
      encoding: "utf8",
    }).trim();
    assert.match(branch, /^sync\/release-v9\.9\.9-/u);
    git(fixture.repo, "switch", branch);
    NodeFS.writeFileSync(NodePath.join(fixture.repo, "retained-review-fix"), "preserve me\n");
    git(fixture.repo, "add", "retained-review-fix");
    git(fixture.repo, "commit", "-m", "candidate review fix");
    git(fixture.repo, "switch", "main");
    NodeFS.writeFileSync(NodePath.join(fixture.repo, "new-downstream-change"), "new base\n");
    git(fixture.repo, "add", "new-downstream-change");
    git(fixture.repo, "commit", "-m", "new downstream change");
    git(fixture.repo, "push", "origin", "main");

    const retry = runReleaseSync(fixture, ["--create-pr"]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, /"status": "review-ready"/u);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(fixture.trace, "order"), "utf8"),
      "install\nchecks\ninstall\nchecks\n",
    );
    const retained = NodeChildProcess.execFileSync(
      "git",
      ["show", `${branch}:retained-review-fix`],
      {
        cwd: fixture.repo,
        encoding: "utf8",
      },
    );
    assert.equal(retained, "preserve me\n");
    git(fixture.repo, "merge-base", "--is-ancestor", "main", branch);
    git(fixture.repo, "merge-base", "--is-ancestor", "v9.9.9", branch);
    const create = githubCalls(fixture).find((args) => args[0] === "pr" && args[1] === "create");
    assert.ok(create);
    assert.equal(create[create.indexOf("--base") + 1], "main");
    assert.match(create[create.indexOf("--body") + 1]!, /Dependencies: `passed`/u);
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

// Conflicts must remain reviewable, without a preference merge dropping upstream behavior.
it("retains release conflicts before installation or PR publication", () => {
  const fixture = createFixture();
  let retained: string | undefined;
  try {
    prepareReleaseFixture(fixture);
    const packagePath = NodePath.join(fixture.repo, "package.json");
    const manifest = JSON.parse(NodeFS.readFileSync(packagePath, "utf8"));
    NodeFS.writeFileSync(
      packagePath,
      `${JSON.stringify({ ...manifest, revision: "downstream" }, null, 2)}\n`,
    );
    git(fixture.repo, "add", "package.json");
    git(fixture.repo, "commit", "-m", "conflicting downstream behavior");
    git(fixture.repo, "push", "origin", "main");
    const result = runReleaseSync(fixture, ["--create-pr"]);
    assert.equal(result.status, 2, result.stderr);
    retained = /Kept sync worktree at (.+)/u.exec(result.stderr)?.[1];
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{\n")));
    retained = report.worktree;
    assert.equal(report.mergeStatus, "conflicted");
    assert.equal(report.checkStatus, "not-run");
    assert.equal(report.installStatus, "not-run");
    assert.ok(retained && NodeFS.existsSync(retained));
    const unresolved = NodeChildProcess.execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      { cwd: retained, encoding: "utf8" },
    );
    assert.match(unresolved, /package\.json/u);
    assert.ok(!NodeFS.existsSync(NodePath.join(fixture.trace, "install.json")));
    assert.ok(!githubCalls(fixture).some((args) => args[0] === "pr" && args[1] === "create"));
  } finally {
    if (retained) {
      git(fixture.repo, "worktree", "remove", "--force", retained);
      NodeFS.rmSync(NodePath.dirname(retained), { recursive: true, force: true });
    }
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("retains an existing candidate's conflicting main refresh before validation", () => {
  const fixture = createFixture();
  let retained: string | undefined;
  try {
    prepareReleaseFixture(fixture);
    const path = NodePath.join(fixture.repo, "refresh-conflict");
    NodeFS.writeFileSync(path, "base\n");
    git(fixture.repo, "add", "refresh-conflict");
    git(fixture.repo, "commit", "-m", "shared behavior");
    git(fixture.repo, "push", "origin", "main");
    const initial = runReleaseSync(fixture);
    assert.equal(initial.status, 0, initial.stderr);
    const branch = NodeChildProcess.execFileSync("git", ["branch", "--list", "sync/release-*"], {
      cwd: fixture.repo,
      encoding: "utf8",
    }).trim();
    git(fixture.repo, "switch", branch);
    NodeFS.writeFileSync(path, "candidate fix\n");
    git(fixture.repo, "commit", "-am", "candidate behavior fix");
    git(fixture.repo, "switch", "main");
    NodeFS.writeFileSync(path, "new main behavior\n");
    git(fixture.repo, "commit", "-am", "conflicting main behavior");
    git(fixture.repo, "push", "origin", "main");
    const result = runReleaseSync(fixture, ["--create-pr"]);
    retained = /Kept sync worktree at (.+)/u.exec(result.stderr)?.[1];
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{\n")));
    assert.equal(report.mergeStatus, "conflicted");
    assert.equal(report.checkStatus, "not-run");
    assert.ok(retained && NodeFS.existsSync(retained));
    assert.match(
      NodeChildProcess.execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
        cwd: retained,
        encoding: "utf8",
      }),
      /refresh-conflict/u,
    );
    assert.equal(
      NodeChildProcess.execFileSync("git", ["show", `${branch}:refresh-conflict`], {
        cwd: fixture.repo,
        encoding: "utf8",
      }),
      "candidate fix\n",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(fixture.trace, "order"), "utf8"),
      "install\nchecks\n",
    );
    assert.ok(!githubCalls(fixture).some((args) => args[0] === "pr" && args[1] === "create"));
  } finally {
    if (retained) {
      git(fixture.repo, "worktree", "remove", "--force", retained);
      NodeFS.rmSync(NodePath.dirname(retained), { recursive: true, force: true });
    }
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});

it("keeps skipped release checks marked as needing review", () => {
  const fixture = createFixture();
  try {
    prepareReleaseFixture(fixture);
    const result = runReleaseSync(fixture, ["--skip-checks"]);
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{\n")));
    assert.equal(report.status, "needs-human-review");
    assert.equal(report.installStatus, "skipped");
    assert.equal(report.checkStatus, "skipped");
    assert.include(report.labels, "needs review");
    assert.ok(!NodeFS.existsSync(NodePath.join(fixture.trace, "install.json")));
  } finally {
    NodeFS.rmSync(fixture.root, { recursive: true, force: true });
  }
});
