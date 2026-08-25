// @effect-diagnostics nodeBuiltinImport:off - exercises the real sync script with local Git worktrees.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const syncScript = NodePath.resolve(repoRoot, "scripts/tritonai-sync-upstream.mjs");

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
    NodePath.join(fakeBin, "corepack"),
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
const expected = ["pnpm", "install", "--frozen-lockfile"];
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

function runSync(fixture: Fixture, installExit = 0) {
  NodeFS.writeFileSync(NodePath.join(fixture.trace, "install-exit"), String(installExit));
  return NodeChildProcess.spawnSync(process.execPath, [syncScript], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: "must-not-reach-merged-worktree-commands",
      PATH: `${fixture.fakeBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      TEST_SENTINEL_SECRET: "must-not-reach-merged-worktree-commands",
      TRITONAI_SYNC_AGENT_COMMAND: "fixture-agent",
      TRITONAI_SYNC_AGENT_SECRET_ENV_ALLOWLIST: "",
      TRITONAI_SYNC_CHECKS: "fixture-check",
      TRITONAI_SYNC_DOWNSTREAM_BRANCH: "main",
      TRITONAI_SYNC_DOWNSTREAM_REMOTE: "origin",
      TRITONAI_SYNC_UPSTREAM_BRANCH: "main",
      TRITONAI_SYNC_UPSTREAM_REMOTE: "upstream",
      TRITONAI_SYNC_UPSTREAM_URL: fixture.upstream,
    },
  });
}

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
    assert.deepStrictEqual(install.args, ["pnpm", "install", "--frozen-lockfile"]);
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
