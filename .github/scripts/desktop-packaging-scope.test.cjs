const assert = require("node:assert/strict");
const test = require("node:test");
const { needsDesktopPackaging } = require("./desktop-packaging-scope.cjs");

test("native packaging runs for transitive inputs and unknown diffs, and skips unrelated changes", () => {
  const refs = { base: "a".repeat(40), head: "b".repeat(40) };
  for (const path of [
    "scripts/prepare-server-compile-cache.cjs",
    "apps/server/src/new-chunk.ts",
    "apps/web/src/new-route.tsx",
    "apps/desktop-runtime/package.json",
    "packages/shared/src/native.ts",
    "native/resource-monitor/src/main.rs",
    "config/managed-plugin-catalog.nightly.json",
    "pnpm-lock.yaml",
    ".pnpmfile.cjs",
    ".github/workflows/ci.yml",
    ".github/fixtures/packaging-plugin-configuration.json",
  ]) {
    assert.equal(
      needsDesktopPackaging(refs, () => [path]),
      true,
      path,
    );
  }
  assert.equal(
    needsDesktopPackaging(refs, () => ["docs/user/updates.md", "apps/mobile/src/app.tsx"]),
    false,
  );
  assert.equal(
    needsDesktopPackaging(refs, () => {
      throw new Error("fetch unavailable");
    }),
    true,
  );
  assert.equal(
    needsDesktopPackaging({ ...refs, base: "0".repeat(40) }, () => assert.fail()),
    true,
  );
});
