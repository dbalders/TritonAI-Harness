const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readChangedPaths, selectWindowsTests } = require("./windows-test-scope.cjs");

const refs = { eventName: "pull_request", base: "a".repeat(40), head: "b".repeat(40) };

test("runs every focused suite when diff resolution fails or refs are unavailable", () => {
  assert.equal(
    selectWindowsTests(refs, () => {
      throw new Error("fetch failed");
    }).include.length,
    3,
  );
  for (const base of [undefined, "", "0".repeat(40), "invalid"]) {
    assert.equal(
      selectWindowsTests({ ...refs, base }, () => assert.fail("invalid refs must not reach git"))
        .include.length,
      3,
    );
  }
});

test("git detection includes a removed source path when it is renamed outside the scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-windows-scope-"));
  const remote = path.join(root, "remote");
  const checkout = path.join(root, "checkout");
  const git = (cwd, ...args) =>
    childProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    fs.mkdirSync(remote);
    git(remote, "init");
    fs.mkdirSync(path.join(remote, "apps/desktop/src"), { recursive: true });
    fs.writeFileSync(path.join(remote, "apps/desktop/src/with space.ts"), "export {};\n");
    git(remote, "add", ".");
    git(remote, "-c", "commit.gpgsign=false", "commit", "-m", "base");
    const base = git(remote, "rev-parse", "HEAD").trim();
    fs.mkdirSync(path.join(remote, "docs"));
    git(remote, "mv", "apps/desktop/src/with space.ts", "docs/with space.ts");
    git(remote, "-c", "commit.gpgsign=false", "commit", "-m", "move out of scope");
    const head = git(remote, "rev-parse", "HEAD").trim();
    git(root, "clone", "--no-local", "--depth=1", remote, checkout);
    const paths = readChangedPaths(base, head, checkout);
    assert.deepEqual(paths.sort(), ["apps/desktop/src/with space.ts", "docs/with space.ts"]);
    assert.equal(selectWindowsTests({ ...refs, base, head }, () => paths).include.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
