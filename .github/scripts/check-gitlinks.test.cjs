const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkGitlinks } = require("./check-gitlinks.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-gitlinks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git("init", "--quiet");
  git(
    "-c",
    "user.name=Gitlink test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const commit = git("rev-parse", "HEAD").trim();
  return {
    root,
    git,
    add: (modulePath) => git("update-index", "--add", "--cacheinfo", "160000", commit, modulePath),
    map: (name, modulePath, url = "https://example.invalid/reference.git") => {
      git("config", "--file", ".gitmodules", `submodule.${name}.path`, modulePath);
      git("config", "--file", ".gitmodules", `submodule.${name}.url`, url);
    },
  };
}

test("detects the moved vendored gitlink even when its directory is absent", (t) => {
  const repo = fixture(t);
  repo.add(".repos/alchemy-effect/submodules/distilled");
  repo.map("distilled", ".repos/alchemy-effect/distilled");
  const result = checkGitlinks(repo.root);
  assert.equal(result.count, 1);
  assert.ok(result.errors.some((error) => error.includes("Stale .gitmodules path")));
  assert.ok(
    result.errors.some(
      (error) => error.includes("submodules/distilled") && error.includes("no root"),
    ),
  );
  assert.equal(fs.existsSync(path.join(repo.root, ".repos")), false);

  repo.map("distilled", ".repos/alchemy-effect/submodules/distilled");
  assert.deepEqual(checkGitlinks(repo.root).errors, []);
  repo.git("submodule", "foreach", "--recursive", "true");
});

test("rejects missing .gitmodules and missing or empty URLs", (t) => {
  const repo = fixture(t);
  repo.add("references/new-agent");
  assert.match(checkGitlinks(repo.root).errors.join("\n"), /no root .gitmodules mapping/);
  repo.git("config", "--file", ".gitmodules", "submodule.agent.path", "references/new-agent");
  assert.match(checkGitlinks(repo.root).errors.join("\n"), /nonempty URL/);
  repo.map("agent", "references/new-agent", "   ");
  assert.match(checkGitlinks(repo.root).errors.join("\n"), /nonempty URL/);
});

test("rejects duplicate mappings and stale entries after a gitlink is removed", (t) => {
  const repo = fixture(t);
  repo.add("references/agent");
  repo.map("first", "references/agent");
  repo.map("second", "references/agent");
  assert.match(checkGitlinks(repo.root).errors.join("\n"), /mapped more than once/);
  repo.git("config", "--file", ".gitmodules", "--remove-section", "submodule.second");
  repo.git("update-index", "--force-remove", "references/agent");
  assert.match(checkGitlinks(repo.root).errors.join("\n"), /Stale .gitmodules path/);
});

test("accepts paths with whitespace and a repository without submodules", (t) => {
  const repo = fixture(t);
  assert.deepEqual(checkGitlinks(repo.root), { count: 0, errors: [] });
  repo.add("references/agent with spaces");
  repo.map("agent.with.dots", "references/agent with spaces");
  assert.deepEqual(checkGitlinks(repo.root), { count: 1, errors: [] });
});

test("CLI fails closed on malformed .gitmodules", (t) => {
  const repo = fixture(t);
  fs.writeFileSync(path.join(repo.root, ".gitmodules"), "[submodule broken\n");
  const result = spawnSync(process.execPath, [path.join(__dirname, "check-gitlinks.cjs")], {
    cwd: repo.root,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bad config/);
});
