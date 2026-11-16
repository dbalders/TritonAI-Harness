const fs = require("node:fs");
const { readChangedPaths } = require("./windows-test-scope.cjs");

function affectsDesktopPackaging(path) {
  return (
    /^(apps\/(desktop|desktop-runtime|server|web)|packages|scripts|native|config|patches|assets)\//.test(
      path,
    ) ||
    /(^|\/)package\.json$/.test(path) ||
    /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|vite\.config\.ts|tsconfig[^/]*\.json|\.npmrc|\.pnpmfile\.cjs|\.node-version|\.gitmodules)$/.test(
      path,
    ) ||
    /^\.github\/(workflows\/(ci|nightly|release|desktop-macos-preview)\.yml|scripts\/|fixtures\/packaging-plugin-configuration\.json)/.test(
      path,
    )
  );
}

function needsDesktopPackaging({ base, head }, readPaths = readChangedPaths) {
  const validSha = (sha) => /^[a-f0-9]{40}$/i.test(sha ?? "") && !/^0+$/.test(sha);
  if (!validSha(base) || !validSha(head)) return true;
  try {
    return readPaths(base, head).some(affectsDesktopPackaging);
  } catch (error) {
    console.warn(`Could not resolve packaging inputs; running native builds: ${error}`);
    return true;
  }
}

module.exports = { needsDesktopPackaging };

if (require.main === module) {
  const changed = needsDesktopPackaging({ base: process.env.BASE_SHA, head: process.env.HEAD_SHA });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
