const childProcess = require("node:child_process");
const fs = require("node:fs");

const suites = [
  {
    label: "shared paths and shell",
    package: "packages/shared",
    files: "src/path.test.ts src/shell.test.ts",
  },
  {
    label: "server filesystem and processes",
    package: "apps/server",
    files:
      "src/workspace/WorkspacePaths.test.ts src/workspace/WorkspaceFileSystem.test.ts src/processRunner.test.ts src/process/externalLauncher.test.ts src/terminal/NodePtyAdapter.test.ts",
  },
  {
    label: "desktop Windows and WSL",
    package: "apps/desktop",
    files:
      "src/electron/WindowsForeground.test.ts src/electron/WindowsForegroundFocusThread.test.ts src/electron/WindowsForegroundFocusWorker.test.ts src/wsl/wslPathParsing.test.ts",
  },
];

// Keep the transitive inputs broad: shared contracts, test setup and dependency
// changes can break Windows even when none of the selected test files changed.
// Include every workspace package so new transitive dependencies cannot silently
// bypass the lane when the app manifests stop changing.
function affectsWindowsTests(path) {
  return (
    /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|vite\.config\.ts|tsconfig[^/]*\.json)$/.test(
      path,
    ) ||
    /^(config|patches|packages|scripts\/lib)\//.test(path) ||
    /^apps\/(desktop|server)\//.test(path) ||
    /^\.github\/(workflows\/(ci|windows-tests)\.yml|scripts\/windows-test-scope(?:\.test)?\.cjs)$/.test(
      path,
    )
  );
}

function readChangedPaths(base, head, cwd = process.cwd()) {
  // Fetch only the two snapshots we compare. A full history fetch is unnecessary
  // and GitHub's changed-files APIs can truncate large pull requests/pushes.
  childProcess.execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", base, head], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 120_000,
  });
  // Disabling rename detection includes both the removed and added paths, so
  // moving a Windows input outside the scope still runs its regression tests.
  return childProcess
    .execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", base, head, "--"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
    })
    .split("\0")
    .filter(Boolean);
}

function selectWindowsTests(
  { eventName, base, head, package: workspace = "", files = "" },
  readPaths,
) {
  if (eventName === "workflow_dispatch") {
    if (files.trim() && !workspace.trim()) {
      throw new Error("Test files require a package.");
    }
    return {
      include: [{ label: workspace || "all non-server", package: workspace, files }],
    };
  }

  const validSha = (sha) => /^[a-f0-9]{40}$/i.test(sha ?? "") && !/^0+$/.test(sha);
  if (!validSha(base) || !validSha(head)) {
    console.warn("Changed-file refs are unavailable; running every focused Windows suite.");
    return { include: suites };
  }
  try {
    return { include: readPaths(base, head).some(affectsWindowsTests) ? suites : [] };
  } catch (error) {
    console.warn(`Could not resolve changed files; running every focused Windows suite: ${error}`);
    return { include: suites };
  }
}

module.exports = { affectsWindowsTests, readChangedPaths, selectWindowsTests };

if (require.main === module) {
  const plan = selectWindowsTests(
    {
      eventName: process.env.EVENT_NAME,
      base: process.env.BASE_SHA,
      head: process.env.HEAD_SHA,
      package: process.env.TEST_PACKAGE,
      files: process.env.TEST_FILES,
    },
    readChangedPaths,
  );
  console.log(JSON.stringify(plan, null, 2));
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=${plan.include.length > 0}\nplan=${JSON.stringify(plan)}\n`,
  );
}
