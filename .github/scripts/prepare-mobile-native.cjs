const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function prepareMobileNative({ root, tag, sourceSha, generatorSha, variant = "preview" }) {
  if (!["preview", "production"].includes(variant)) throw new Error("Unsupported mobile variant");
  const isProduction = variant === "production";
  const nativeName = isProduction ? "TritonAIHarness" : "TritonAIHarnessPreview";
  const bundleId = `edu.ucsd.tritonai.harness${isProduction ? "" : ".preview"}`;
  const validTag = isProduction
    ? /^(?:v\d+\.\d+\.\d+|main)$/
    : /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/;
  if (!validTag.test(tag)) {
    throw new Error(
      isProduction
        ? "Expected a published stable tag or manual main build"
        : "Expected a published nightly tag",
    );
  }
  if (![sourceSha, generatorSha].every((sha) => /^[a-f0-9]{40}$/.test(sha))) {
    throw new Error("Expected full source and generator commit SHAs");
  }
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== sourceSha) {
    throw new Error("Native project must come from the exact mobile source");
  }
  git("diff", "--exit-code", "HEAD", "--", ".");

  const ios = path.join(root, "apps/mobile/ios");
  const project = fs.readFileSync(
    path.join(ios, `${nativeName}.xcodeproj/project.pbxproj`),
    "utf8",
  );
  const expectedBundles = new Set([bundleId, `${bundleId}.widgets`, `${bundleId}.sharing`]);
  const bundles = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g)].map(
    (match) => match[1],
  );
  if (
    bundles.some((bundle) => !expectedBundles.has(bundle)) ||
    [...expectedBundles].some((bundle) => !bundles.includes(bundle))
  ) {
    throw new Error(
      `Native project must contain only the ${isProduction ? "production" : "Preview"} app and its extensions`,
    );
  }
  const teams = [...project.matchAll(/DEVELOPMENT_TEAM = "?([^";]+)"?;/g)].map((match) => match[1]);
  if (teams.length === 0 || teams.some((team) => team !== "G789749RTK")) {
    throw new Error("All native targets must use the UCSD team");
  }
  const scheme = fs.readFileSync(
    path.join(ios, `${nativeName}.xcodeproj/xcshareddata/xcschemes/${nativeName}.xcscheme`),
    "utf8",
  );
  if (!scheme.includes("<ArchiveAction") || !/buildForArchiving\s*=\s*"YES"/.test(scheme)) {
    throw new Error("Mobile app must have a shared scheme that supports archiving");
  }

  const scripts = path.join(ios, "ci_scripts");
  fs.mkdirSync(scripts, { recursive: true });
  const hook = path.join(scripts, "ci_post_clone.sh");
  fs.copyFileSync(path.join(__dirname, "xcode-cloud/ci_post_clone.sh"), hook);
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(
    path.join(scripts, isProduction ? "stable-source.json" : "nightly-source.json"),
    `${JSON.stringify({ tag, sourceSha, generatorSha, ...(isProduction ? { variant } : {}) }, null, 2)}\n`,
  );

  const workspace = path.join(ios, `${nativeName}.xcworkspace`);
  const resolved = JSON.parse(
    fs.readFileSync(path.join(workspace, "xcshareddata/swiftpm/Package.resolved"), "utf8"),
  );
  if (!Array.isArray(resolved.pins) || resolved.pins.length === 0) {
    throw new Error("Swift package dependencies must be resolved before publishing to Xcode Cloud");
  }
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "contents.xcworkspacedata"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<Workspace version="1.0">\n  <FileRef location="group:${nativeName}.xcodeproj"/>\n  <FileRef location="group:Pods/Pods.xcodeproj"/>\n</Workspace>\n`,
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
    "--quiet",
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

module.exports = { prepareMobileNative };
if (require.main === module) {
  const [root, tag, sourceSha, generatorSha, variant] = process.argv.slice(2);
  console.log(prepareMobileNative({ root, tag, sourceSha, generatorSha, variant }));
}
