// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const upstreamScript = NodePath.join(repoRoot, "scripts/tritonai-sync-upstream.mjs");
const releaseScript = NodePath.join(repoRoot, "scripts/tritonai-release-sync.mjs");

type Fixture = {
  readonly root: string;
  readonly repo: string;
  readonly upstreamBare: string;
  readonly approveCommand: string;
  readonly ghLog: string;
  readonly env: NodeJS.ProcessEnv;
};

type ScriptResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly report: Record<string, unknown> | null;
};

function run(command: string, args: ReadonlyArray<string>, cwd: string): string {
  return NodeChildProcess.execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

function git(cwd: string, ...args: ReadonlyArray<string>): string {
  return run("git", args, cwd);
}

function write(path: string, contents: string): void {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
}

function commit(cwd: string, message: string): void {
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", message);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createFixture(options: { readonly conflict?: boolean } = {}): Fixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tritonai-sync-test-"));
  const base = NodePath.join(root, "base");
  const originBare = NodePath.join(root, "origin.git");
  const upstreamBare = NodePath.join(root, "upstream.git");
  const upstreamWork = NodePath.join(root, "upstream-work");
  const repo = NodePath.join(root, "repo");

  git(root, "init", "--initial-branch=main", base);
  git(base, "config", "user.name", "Sync Test");
  git(base, "config", "user.email", "sync@example.test");
  write(NodePath.join(base, "shared.txt"), "base\n");
  commit(base, "base");
  git(root, "clone", "--bare", base, originBare);
  git(root, "clone", "--bare", base, upstreamBare);
  git(root, "clone", originBare, repo);
  git(repo, "config", "user.name", "Sync Test");
  git(repo, "config", "user.email", "sync@example.test");
  git(root, "clone", upstreamBare, upstreamWork);
  git(upstreamWork, "config", "user.name", "Sync Test");
  git(upstreamWork, "config", "user.email", "sync@example.test");

  if (options.conflict) {
    write(NodePath.join(repo, "shared.txt"), "downstream\n");
    commit(repo, "downstream conflict");
    git(repo, "push", "origin", "main");
    write(NodePath.join(upstreamWork, "shared.txt"), "upstream\n");
  } else {
    write(NodePath.join(upstreamWork, "upstream.txt"), "upstream\n");
  }
  commit(upstreamWork, "upstream change");
  git(upstreamWork, "tag", "v1.0.0");
  git(upstreamWork, "push", "origin", "main", "--tags");

  const approveAgent = NodePath.join(root, "approve-agent.mjs");
  write(
    approveAgent,
    `import fs from "node:fs";\nfs.writeFileSync(process.env.TRITONAI_SYNC_AGENT_RESPONSE_FILE, JSON.stringify({ approved: true, reason: "ok", summary: "approved", risks: [] }));\n`,
  );

  const fakeBin = NodePath.join(root, "bin");
  const gh = NodePath.join(fakeBin, "gh");
  const ghLog = NodePath.join(root, "gh.log");
  write(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "release list") printf '%s\\n' '{"tagName":"v1.0.0","publishedAt":"2026-07-09T00:00:00Z"}' ;;
  "pr list") exit 0 ;;
  "pr create") printf '%s\\n' 'https://example.test/pull/1' ;;
  "pr view") printf '%s\\n' 'false' ;;
esac
`,
  );
  NodeFS.chmodSync(gh, 0o755);

  return {
    root,
    repo,
    upstreamBare,
    approveCommand: `${shellQuote(process.execPath)} ${shellQuote(approveAgent)}`,
    ghLog,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      GH_LOG: ghLog,
      GH_REPO: "example/repo",
      TRITONAI_SYNC_UPSTREAM_URL: upstreamBare,
      TRITONAI_SYNC_CHECKS: "true",
      TRITONAI_SYNC_AGENT_COMMAND: `${shellQuote(process.execPath)} ${shellQuote(approveAgent)}`,
      TRITONAI_RELEASE_SYNC_PARENT_URL: upstreamBare,
      TRITONAI_RELEASE_SYNC_CHECKS: "true",
    },
  };
}

function extractLastJson(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const start = trimmed.lastIndexOf("\n{");
  return JSON.parse(start >= 0 ? trimmed.slice(start + 1) : trimmed) as Record<string, unknown>;
}

function runScript(
  script: string,
  args: ReadonlyArray<string>,
  fixture: Fixture,
  env: NodeJS.ProcessEnv = {},
): ScriptResult {
  const result = NodeChildProcess.spawnSync(process.execPath, [script, ...args], {
    cwd: fixture.repo,
    env: { ...fixture.env, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: extractLastJson(result.stdout),
  };
}

function automationBranches(fixture: Fixture, prefix: string): ReadonlyArray<string> {
  const output = git(fixture.repo, "branch", "--list", `${prefix}*`, "--format=%(refname:short)");
  return output ? output.split("\n") : [];
}

function cleanup(fixture: Fixture): void {
  if (NodeFS.existsSync(fixture.repo)) {
    for (const line of git(fixture.repo, "worktree", "list", "--porcelain").split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const worktree = line.slice("worktree ".length);
      if (NodeFS.realpathSync(worktree) !== NodeFS.realpathSync(fixture.repo)) {
        git(fixture.repo, "worktree", "remove", "--force", worktree);
      }
    }
  }
  NodeFS.rmSync(fixture.root, { recursive: true, force: true });
}

describe("TritonAI sync tooling", () => {
  it("enforces a verified fetch-only parent remote and refuses mismatches", () => {
    const fixture = createFixture();
    try {
      git(fixture.repo, "remote", "add", "t3code-upstream", fixture.upstreamBare);
      git(fixture.repo, "remote", "set-url", "--add", "--push", "t3code-upstream", "unsafe-push");
      const result = runScript(
        upstreamScript,
        ["--no-llm", "--skip-checks", "--allow-needs-review"],
        fixture,
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(git(fixture.repo, "remote", "get-url", "t3code-upstream"), fixture.upstreamBare);
      assert.equal(
        git(fixture.repo, "remote", "get-url", "--push", "--all", "t3code-upstream"),
        "DISABLED",
      );

      git(fixture.repo, "remote", "set-url", "t3code-upstream", "wrong-parent");
      const refused = runScript(upstreamScript, [], fixture);
      assert.equal(refused.status, 1);
      assert.include(refused.stderr, "Refusing parent remote t3code-upstream");
      assert.equal(git(fixture.repo, "remote", "get-url", "t3code-upstream"), "wrong-parent");

      git(fixture.repo, "config", "--unset-all", "remote.t3code-upstream.url");
      git(fixture.repo, "config", "--add", "remote.t3code-upstream.url", fixture.upstreamBare);
      git(fixture.repo, "config", "--add", "remote.t3code-upstream.url", "second-parent");
      const multiple = runScript(upstreamScript, [], fixture);
      assert.equal(multiple.status, 1);
      assert.include(multiple.stderr, "expected only fetch URL");

      git(fixture.repo, "config", "--unset-all", "remote.t3code-upstream.url");
      git(fixture.repo, "config", "--add", "remote.t3code-upstream.url", fixture.upstreamBare);
      git(fixture.repo, "remote", "set-url", "origin", fixture.upstreamBare);
      const aliased = runScript(upstreamScript, [], fixture);
      assert.equal(aliased.status, 1);
      assert.include(aliased.stderr, "must not also be configured on downstream remote origin");
    } finally {
      cleanup(fixture);
    }
  });

  it("fails closed on skipped, failed, or unconfigured checks and review, then retries cleanly", () => {
    const fixture = createFixture();
    try {
      const cases = [
        runScript(upstreamScript, ["--skip-checks"], fixture),
        runScript(upstreamScript, [], fixture, { TRITONAI_SYNC_CHECKS: "false" }),
        runScript(upstreamScript, [], fixture, { TRITONAI_SYNC_CHECKS: "" }),
        runScript(upstreamScript, ["--no-llm"], fixture),
        runScript(upstreamScript, [], fixture, { TRITONAI_SYNC_AGENT_COMMAND: "false" }),
        runScript(upstreamScript, [], fixture, { TRITONAI_SYNC_AGENT_COMMAND: "" }),
      ];
      for (const result of cases) {
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.report?.status, "needs-human-review");
        assert.deepStrictEqual(automationBranches(fixture, "sync/upstream-"), []);
      }

      const ready = runScript(upstreamScript, [], fixture);
      assert.equal(ready.status, 0, ready.stderr);
      assert.equal(ready.report?.status, "review-ready");
      assert.equal(ready.report?.checkStatus, "passed");
      assert.equal(ready.report?.reviewStatus, "approved");
      assert.deepStrictEqual(automationBranches(fixture, "sync/upstream-"), []);
    } finally {
      cleanup(fixture);
    }
  });

  it("preserves conflict evidence without an ours retry and cleans for deterministic retries", () => {
    const fixture = createFixture({ conflict: true });
    try {
      for (const script of [upstreamScript, releaseScript]) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const args = script === upstreamScript ? ["--no-llm", "--skip-checks"] : [];
          const result = runScript(script, args, fixture);
          assert.equal(result.status, 2, result.stderr);
          assert.equal(result.report?.mergeStatus, "conflicted");
          const evidence = result.report?.conflictEvidence as
            | { readonly files?: ReadonlyArray<string>; readonly stages?: ReadonlyArray<string> }
            | undefined;
          assert.deepStrictEqual(evidence?.files, ["shared.txt"]);
          assert.isAbove(evidence?.stages?.length ?? 0, 0);
          assert.deepStrictEqual(automationBranches(fixture, "sync/upstream-"), []);
          assert.deepStrictEqual(automationBranches(fixture, "sync/release-"), []);
          assert.lengthOf(
            git(fixture.repo, "worktree", "list", "--porcelain")
              .split("\n")
              .filter((line) => line.startsWith("worktree ")),
            1,
          );
        }
      }
    } finally {
      cleanup(fixture);
    }
  });

  it("creates ready PRs, never invokes merge, and cleans local retry state", () => {
    const fixture = createFixture();
    try {
      const result = runScript(upstreamScript, ["--create-pr"], fixture);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.report?.status, "review-ready");
      const ghLog = NodeFS.readFileSync(fixture.ghLog, "utf8");
      assert.include(ghLog, "pr create");
      assert.include(ghLog, "--base main");
      assert.notInclude(ghLog, "--draft");
      assert.notInclude(ghLog, "pr merge");
      assert.include(ghLog, "pr view");
      assert.deepStrictEqual(automationBranches(fixture, "sync/upstream-"), []);
    } finally {
      cleanup(fixture);
    }
  });

  it("keeps release sync human-review-required when checks or review are unconfigured", () => {
    const fixture = createFixture();
    try {
      const skipped = runScript(releaseScript, ["--skip-checks"], fixture);
      assert.equal(skipped.status, 2, skipped.stderr);
      assert.equal(skipped.report?.status, "needs-human-review");
      assert.equal(skipped.report?.checkStatus, "skipped");
      assert.equal(skipped.report?.reviewStatus, "not-configured");
      assert.deepStrictEqual(automationBranches(fixture, "sync/release-"), []);

      const reviewRequired = runScript(releaseScript, ["--create-pr"], fixture);
      assert.equal(reviewRequired.status, 2, reviewRequired.stderr);
      assert.equal(reviewRequired.report?.status, "needs-human-review");
      assert.equal(reviewRequired.report?.checkStatus, "passed");
      assert.equal(reviewRequired.report?.reviewStatus, "not-configured");
      const ghLog = NodeFS.readFileSync(fixture.ghLog, "utf8");
      assert.notInclude(ghLog, "--draft");
      assert.notInclude(ghLog, "pr merge");
      assert.include(ghLog, "pr view");
      assert.deepStrictEqual(automationBranches(fixture, "sync/release-"), []);
    } finally {
      cleanup(fixture);
    }
  });

  it("preserves unexpected dirty work instead of force-removing it", () => {
    const fixture = createFixture();
    try {
      const result = runScript(upstreamScript, ["--no-llm"], fixture, {
        TRITONAI_SYNC_CHECKS: "printf preserved > user-work.txt; false",
      });
      assert.equal(result.status, 2, result.stderr);
      const match = result.stderr.match(/Kept dirty sync worktree at (.+); refusing/u);
      assert.isNotNull(match);
      const worktree = match?.[1] ?? "";
      assert.equal(
        NodeFS.readFileSync(NodePath.join(worktree, "user-work.txt"), "utf8"),
        "preserved",
      );
      assert.deepStrictEqual(automationBranches(fixture, "sync/upstream-"), []);
    } finally {
      cleanup(fixture);
    }
  });
});
