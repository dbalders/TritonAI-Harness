const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function git(root, args, emptyStatus = null) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (emptyStatus !== null && result.status === emptyStatus) return "";
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

function checkGitlinks(root) {
  const gitlinks = new Set(
    git(root, ["ls-files", "--stage", "-z"])
      .split("\0")
      .filter((entry) => entry.startsWith("160000 "))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
  );
  const entries = fs.existsSync(path.join(root, ".gitmodules"))
    ? git(
        root,
        [
          "config",
          "--file",
          ".gitmodules",
          "--null",
          "--get-regexp",
          "^submodule\\..*\\.(path|url)$",
        ],
        1,
      )
    : "";
  const modules = new Map();
  for (const entry of entries.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n");
    const [, name, field] = /^submodule\.(.+)\.(path|url)$/.exec(entry.slice(0, separator));
    const module = modules.get(name) ?? { path: [], url: [] };
    module[field].push(entry.slice(separator + 1));
    modules.set(name, module);
  }

  const errors = [];
  const mapped = new Set();
  for (const [name, module] of modules) {
    if (module.path.length !== 1 || !module.path[0]) {
      errors.push(`Submodule ${JSON.stringify(name)} must declare exactly one nonempty path.`);
      continue;
    }
    const modulePath = module.path[0];
    if (module.url.length !== 1 || !module.url[0].trim()) {
      errors.push(`Submodule ${JSON.stringify(modulePath)} must declare exactly one nonempty URL.`);
    }
    if (mapped.has(modulePath)) {
      errors.push(`Submodule path ${JSON.stringify(modulePath)} is mapped more than once.`);
    }
    mapped.add(modulePath);
    if (!gitlinks.has(modulePath)) {
      errors.push(`Stale .gitmodules path ${JSON.stringify(modulePath)} has no tracked gitlink.`);
    }
  }
  for (const gitlink of gitlinks) {
    if (!mapped.has(gitlink)) {
      errors.push(`Tracked gitlink ${JSON.stringify(gitlink)} has no root .gitmodules mapping.`);
    }
  }
  return { count: gitlinks.size, errors };
}

if (require.main === module) {
  try {
    const { count, errors } = checkGitlinks(process.cwd());
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      console.error(
        "Update root .gitmodules whenever vendored references add, move, or remove gitlinks.",
      );
      process.exitCode = 1;
    } else {
      console.log(`Validated ${count} gitlink mappings.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkGitlinks };
