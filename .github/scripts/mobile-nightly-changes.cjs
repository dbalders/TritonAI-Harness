const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const NATIVE_BRANCH = "mobile-nightly";
const RECEIPT = "apps/mobile/ios/ci_scripts/nightly-source.json";
// Outside the mobile workspace closure, these files reach the Preview build:
// app.config.ts imports the brand and config modules and reads icons from
// assets/; metro.config.js generates the in-app notices from the license
// config, whose notice files are added by licenseNoticeFiles.
const SHARED_INPUTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches",
  "assets",
  "scripts/lib/brand-assets.ts",
  "scripts/lib/public-config.ts",
  "scripts/lib/third-party-licenses.ts",
  "third-party-licenses.config.json",
  ".github/scripts/prepare-mobile-native.cjs",
  ".github/scripts/prepare-nightly-mobile-native.cjs",
  ".github/scripts/xcode-cloud",
  ".github/workflows/mobile-nightly-testflight.yml",
];
const LICENSE_CONFIG = "third-party-licenses.config.json";
const IGNORED = ["**/*.test.ts", "**/*.test.tsx"].map((glob) => `:(exclude,glob)${glob}`);

function workspacePackages(root) {
  const manifest = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const block = manifest.match(/^packages:\n((?:[ \t]+-.*\n?)+)/m);
  if (!block) throw new Error("pnpm-workspace.yaml has no packages list");
  const packages = new Map();
  for (const line of block[1].trim().split("\n")) {
    const pattern = line.replace(/^\s*-\s*/, "").replace(/^["']|["']$/g, "");
    const directories = pattern.endsWith("/*")
      ? fs
          .readdirSync(path.join(root, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${pattern.slice(0, -2)}/${entry.name}`)
      : [pattern];
    for (const directory of directories) {
      const file = path.join(root, directory, "package.json");
      if (fs.existsSync(file))
        packages.set(JSON.parse(fs.readFileSync(file, "utf8")).name, directory);
    }
  }
  return packages;
}

// Every workspace package the mobile app installs, including transitive ones.
function mobileWorkspaceClosure(root) {
  const packages = workspacePackages(root);
  const closure = new Set();
  const pending = ["apps/mobile"];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (closure.has(directory)) continue;
    closure.add(directory);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, directory, "package.json"), "utf8"),
    );
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (String(range).startsWith("workspace:") && packages.has(name)) {
          pending.push(packages.get(name));
        }
      }
    }
  }
  return [...closure].toSorted();
}

function licenseNoticeFiles(root) {
  const file = path.join(root, LICENSE_CONFIG);
  if (!fs.existsSync(file)) return [];
  const notices = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (key === "noticeFile" && typeof entry === "string") notices.add(entry);
        else if (key === "noticeFiles" && Array.isArray(entry))
          entry.forEach((n) => notices.add(n));
        else visit(entry);
      }
    }
  };
  try {
    visit(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    // The config is itself an input, so a change that breaks it still builds.
    return [];
  }
  return [...notices].filter((notice) => typeof notice === "string").toSorted();
}

function mobileInputPaths(root) {
  return [
    ...new Set([...mobileWorkspaceClosure(root), ...SHARED_INPUTS, ...licenseNoticeFiles(root)]),
  ];
}

// The newest native commit that Xcode Cloud archived successfully. Failed,
// pending, or never-started builds are skipped so their changes are retried.
async function lastSuccessfulMobileSource({ github, context, limit = 15 }) {
  let ref = NATIVE_BRANCH;
  for (let step = 0; step < limit && ref; step += 1) {
    let commit;
    try {
      ({ data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref }));
    } catch (error) {
      if (step === 0 && [404, 422].includes(error.status)) return null;
      throw error;
    }
    const { data: checks } = await github.rest.checks.listForRef({
      ...context.repo,
      ref: commit.sha,
      per_page: 100,
    });
    const archived = checks.check_runs.some(
      (run) => run.app?.slug === "xcode-cloud" && run.conclusion === "success",
    );
    if (archived) {
      const { data: file } = await github.rest.repos.getContent({
        ...context.repo,
        path: RECEIPT,
        ref: commit.sha,
      });
      const receipt = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      if (!/^[a-f0-9]{40}$/.test(receipt.sourceSha ?? "")) {
        throw new Error(`Native commit ${commit.sha} has an invalid source receipt`);
      }
      return { nativeSha: commit.sha, tag: receipt.tag, sourceSha: receipt.sourceSha };
    }
    // Native commits have the previous native commit as their first parent;
    // the first one ever published has only its source commit.
    ref = commit.parents.length > 1 ? commit.parents[0].sha : null;
  }
  return null;
}

function decideMobileBuild({ root, sourceSha, baseline, force = false }) {
  if (force) return { build: true, reason: "A manual build was requested." };
  if (!baseline) {
    return { build: true, reason: "No successful Xcode Cloud build was found to compare against." };
  }
  if (baseline.sourceSha === sourceSha) {
    return { build: false, reason: `${baseline.tag} already built this source successfully.` };
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("cat-file", "-e", `${baseline.sourceSha}^{commit}`);
  } catch {
    return {
      build: true,
      reason: `The last built source ${baseline.sourceSha} is not in this checkout.`,
    };
  }
  const changed = git(
    "diff",
    "--name-only",
    baseline.sourceSha,
    sourceSha,
    "--",
    ...mobileInputPaths(root),
    ...IGNORED,
  )
    .split("\n")
    .filter(Boolean);
  if (changed.length === 0) {
    return { build: false, reason: `No mobile inputs changed since ${baseline.tag}.`, changed };
  }
  return {
    build: true,
    reason: `${changed.length} mobile input file(s) changed since ${baseline.tag}.`,
    changed,
  };
}

async function resolveMobileBuild({ github, context, core, root, sourceSha, force }) {
  let baseline = null;
  if (!force) {
    try {
      baseline = await lastSuccessfulMobileSource({ github, context });
    } catch (error) {
      core.warning(`Could not find the last successful mobile build: ${error.message}`);
    }
  }
  const decision = decideMobileBuild({ root, sourceSha, baseline, force });
  core.setOutput("build", String(decision.build));
  const summary = [
    `## Nightly mobile build ${decision.build ? "needed" : "skipped"}`,
    `- ${decision.reason}`,
    ...(baseline ? [`- Compared with: ${baseline.tag} (${baseline.sourceSha})`] : []),
    ...(decision.changed ?? []).slice(0, 25).map((file) => `- \`${file}\``),
    ...((decision.changed?.length ?? 0) > 25
      ? [`- …and ${decision.changed.length - 25} more`]
      : []),
  ];
  await core.summary.addRaw(`${summary.join("\n")}\n`).write();
  return decision;
}

module.exports = {
  decideMobileBuild,
  lastSuccessfulMobileSource,
  mobileInputPaths,
  mobileWorkspaceClosure,
  resolveMobileBuild,
};
