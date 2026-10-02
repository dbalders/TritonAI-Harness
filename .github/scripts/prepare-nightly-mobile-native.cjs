const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function prepareNightlyMobileNative({ root, tag, sourceSha, generatorSha }) {
  if (!/^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag)) {
    throw new Error("Expected a published nightly tag");
  }
  if (![sourceSha, generatorSha].every((sha) => /^[a-f0-9]{40}$/.test(sha))) {
    throw new Error("Expected full source and generator commit SHAs");
  }
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== sourceSha) {
    throw new Error("Native project must come from the exact nightly source");
  }
  git("diff", "--exit-code", "HEAD", "--", ".");

  const ios = path.join(root, "apps/mobile/ios");
  const project = fs.readFileSync(
    path.join(ios, "TritonAIHarnessPreview.xcodeproj/project.pbxproj"),
    "utf8",
  );
  const expectedBundles = new Set([
    "edu.ucsd.tritonai.harness.preview",
    "edu.ucsd.tritonai.harness.preview.widgets",
    "edu.ucsd.tritonai.harness.preview.sharing",
  ]);
  const bundles = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)].map(
    (match) => match[1],
  );
  if (
    bundles.some((bundle) => !expectedBundles.has(bundle)) ||
    [...expectedBundles].some((bundle) => !bundles.includes(bundle))
  ) {
    throw new Error("Native project must contain only the Preview app and its extensions");
  }
  const teams = [...project.matchAll(/DEVELOPMENT_TEAM = "?([^";]+)"?;/g)].map((match) => match[1]);
  if (teams.length === 0 || teams.some((team) => team !== "G789749RTK")) {
    throw new Error("All native targets must use the UCSD team");
  }
  const scheme = fs.readFileSync(
    path.join(
      ios,
      "TritonAIHarnessPreview.xcodeproj/xcshareddata/xcschemes/TritonAIHarnessPreview.xcscheme",
    ),
    "utf8",
  );
  if (!scheme.includes("<ArchiveAction") || !/buildForArchiving\s*=\s*"YES"/.test(scheme)) {
    throw new Error("Preview must have a shared scheme that supports archiving");
  }

  const scripts = path.join(ios, "ci_scripts");
  fs.mkdirSync(scripts, { recursive: true });
  const hook = path.join(scripts, "ci_post_clone.sh");
  fs.copyFileSync(path.join(__dirname, "xcode-cloud/ci_post_clone.sh"), hook);
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(
    path.join(scripts, "nightly-source.json"),
    `${JSON.stringify({ tag, sourceSha, generatorSha }, null, 2)}\n`,
  );

  const workspace = path.join(ios, "TritonAIHarnessPreview.xcworkspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "contents.xcworkspacedata"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version="1.0">\n  <FileRef location="group:TritonAIHarnessPreview.xcodeproj"/>\n  <FileRef location="group:Pods/Pods.xcodeproj"/>\n</Workspace>\n',
  );

  const excluded = new Set([
    "Pods",
    "build",
    "DerivedData",
    "xcuserdata",
    ".DS_Store",
    ".xcode.env.local",
    "Podfile.lock",
  ]);
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Native sources must not contain symlinks");
      if (entry.isDirectory()) visit(file);
      else {
        if (
          /\.(?:p8|p12|pfx|key|mobileprovision|pem)$/i.test(entry.name) ||
          entry.name.startsWith(".env")
        ) {
          throw new Error(
            "Native sources must not contain signing credentials or environment files",
          );
        }
        files.push(path.relative(root, file));
      }
    }
  }
  visit(ios);
  // Reference checkouts are unrelated to the mobile build. Xcode Cloud eagerly
  // clones every Git submodule before running our dependency setup hook.
  // This generated branch also needs no GitHub workflows; omitting them avoids
  // requiring workflow-write permission merely to publish a native build tree.
  git(
    "rm",
    "--cached",
    "-r",
    "--force",
    "--ignore-unmatch",
    "--",
    ".repos",
    ".gitmodules",
    ".github/workflows",
  );
  git("add", "--force", "--", ...files);
  return git("write-tree");
}

module.exports = { prepareNightlyMobileNative };
if (require.main === module) {
  const [root, tag, sourceSha, generatorSha] = process.argv.slice(2);
  console.log(prepareNightlyMobileNative({ root, tag, sourceSha, generatorSha }));
}
