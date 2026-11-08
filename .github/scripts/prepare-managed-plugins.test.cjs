"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  assertCanonicalPluginRepository,
  CANONICAL_PLUGIN_REPOSITORY_URL,
} = require("./managed-plugins/plugin-provenance.cjs");
const {
  assertArtifactBinding,
  assertMatchingPluginComposition,
  isSafeRelativePath,
  validateManagedPluginBundleManifest,
} = require("./managed-plugins/plugin-bundle-manifest.cjs");
const {
  assertCatalogComposition,
  readManagedPluginCatalog,
  validateManagedPluginCatalog,
} = require("./managed-plugins/plugin-catalog.cjs");
const {
  assertRemoteRefResolvesToCommit,
  compareStableVersions,
  createLocalCandidatePluginCatalog,
  markLocalReleaseCandidate,
  parseArguments,
  parseLatestStablePluginRelease,
  parseSelectedPluginIds,
  readPluginSourceEnvironment,
  readPluginCatalogSelection,
  selectPluginSourceInput,
  stagePluginsFromSource,
  materializeSelectedPluginTrees,
  validatePluginManifest,
  validateSourceInput,
} = require("./prepare-managed-plugins.cjs");
const COMMIT = "a".repeat(40);
const managedPluginCatalogPath = path.resolve(
  __dirname,
  "../../config/managed-plugin-catalog.json",
);
const nightlyPluginCatalogPath = path.resolve(
  __dirname,
  "../../config/managed-plugin-catalog.nightly.json",
);
function assertLocalCandidateCatalogSelection() {
  withTempRoot("tritonai-local-candidate-catalog-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const catalogPath = path.join(tempRoot, "candidate-plugins.json");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.2.3");
    const composition = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: { ...sourceIdentity(), ref: COMMIT },
    });
    const candidateCatalog = createLocalCandidatePluginCatalog(composition);
    assertCatalogComposition(candidateCatalog, composition);
    fs.writeFileSync(catalogPath, `${JSON.stringify(candidateCatalog)}\n`);
    const production = { production: true };
    const env = {
      TRITONAI_LOCAL_RELEASE_CANDIDATE: "1",
      TRITONAI_PLUGIN_CATALOG_PATH: catalogPath,
      TRITONAI_PLUGINS_SOURCE: sourceRoot,
    };
    const selection = readPluginCatalogSelection(env, production);
    assert.strictEqual(selection.localCandidate, true);
    assert.deepStrictEqual(selection.catalog, candidateCatalog);
    assert.strictEqual(
      selection.catalogSha256,
      crypto.createHash("sha256").update(fs.readFileSync(catalogPath)).digest("hex"),
    );
    const input = selectPluginSourceInput(
      readPluginSourceEnvironment(env),
      { ...production, localCandidate: selection.localCandidate },
      undefined,
      selection.catalog,
    );
    assert.strictEqual(input.ref, COMMIT);
    assert.strictEqual(input.commit, COMMIT);
    assert.strictEqual(input.localSource, sourceRoot);
    assert.deepStrictEqual(input.selectedIds, ["alpha-reader"]);
    for (const override of [
      { TRITONAI_PLUGINS_REF: "refs/heads/main" },
      { TRITONAI_PLUGINS_COMMIT: "b".repeat(40) },
      { TRITONAI_PLUGIN_IDS: "zeta-reader" },
    ]) {
      assert.throws(
        () =>
          selectPluginSourceInput(
            readPluginSourceEnvironment({ ...env, ...override }),
            { ...production, localCandidate: true },
            undefined,
            selection.catalog,
          ),
        /source overrides must be unset/,
      );
    }
    for (const invalidEnv of [
      { TRITONAI_PLUGIN_CATALOG_PATH: catalogPath },
      { TRITONAI_LOCAL_RELEASE_CANDIDATE: "1" },
      { ...env, TRITONAI_LOCAL_RELEASE_CANDIDATE: "true" },
    ]) {
      assert.throws(
        () => readPluginCatalogSelection(invalidEnv, production),
        /requires --production/,
      );
    }
    assert.throws(
      () => readPluginCatalogSelection(env, { production: false }),
      /requires --production/,
    );
    assert.throws(
      () =>
        readPluginCatalogSelection(
          { ...env, TRITONAI_PLUGIN_CATALOG_PATH: "candidate.json" },
          production,
        ),
      /absolute path/,
    );
    assert.throws(
      () =>
        readPluginCatalogSelection(
          { ...env, TRITONAI_PLUGIN_CATALOG_PATH: managedPluginCatalogPath },
          production,
        ),
      /separate from the reviewed/,
    );
    const link = path.join(tempRoot, "catalog-link.json");
    fs.symlinkSync(catalogPath, link);
    assert.throws(
      () => readPluginCatalogSelection({ ...env, TRITONAI_PLUGIN_CATALOG_PATH: link }, production),
      /regular file/,
    );
    const markerPath = markLocalReleaseCandidate(selection, tempRoot);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.deepStrictEqual(marker.pluginCatalog, {
      path: catalogPath,
      sha256: selection.catalogSha256,
    });
    const originalVendor = fs.readFileSync(path.join(vendorDir, "manifest.json"));
    fs.appendFileSync(path.join(sourceRoot, "plugins", "alpha-reader", "README.md"), "changed\n");
    assert.throws(
      () =>
        stagePluginsFromSource({
          sourceRoot,
          vendorDir,
          selectedIds: input.selectedIds,
          source: candidateCatalog.source,
          assertComposition: (manifest) => assertCatalogComposition(selection.catalog, manifest),
        }),
      /catalog digests/,
    );
    assert.deepStrictEqual(fs.readFileSync(path.join(vendorDir, "manifest.json")), originalVendor);
    assert.throws(
      () =>
        readPluginCatalogSelection(
          { ...env, TRITONAI_PLUGIN_CATALOG_PATH: nightlyPluginCatalogPath },
          production,
        ),
      /separate from the reviewed/,
    );
    assert.throws(
      () => readPluginCatalogSelection(env, { production: true, nightly: true }),
      /cannot be combined with --nightly/,
    );
    assert.strictEqual(readPluginCatalogSelection({}, production).localCandidate, false);
    assert.strictEqual(
      readPluginCatalogSelection({}, production).catalogPath,
      managedPluginCatalogPath,
    );
    assert.strictEqual(
      readPluginCatalogSelection({}, { production: true, nightly: true }).catalogPath,
      nightlyPluginCatalogPath,
    );
    const reviewedProductionPath = path.join(tempRoot, "reviewed-production.json");
    const reviewedNightlyPath = path.join(tempRoot, "reviewed-nightly.json");
    const nightlyCatalog = validateManagedPluginCatalog({
      ...candidateCatalog,
      source: { ...candidateCatalog.source, ref: "refs/tags/v9.9.9", commit: "b".repeat(40) },
    });
    fs.writeFileSync(reviewedProductionPath, `${JSON.stringify(candidateCatalog)}\n`);
    fs.writeFileSync(reviewedNightlyPath, `${JSON.stringify(nightlyCatalog)}\n`);
    const productionSelection = readPluginCatalogSelection(
      {},
      production,
      reviewedProductionPath,
      reviewedNightlyPath,
    );
    assert.strictEqual(productionSelection.catalogPath, reviewedProductionPath);
    assert.deepStrictEqual(productionSelection.catalog, candidateCatalog);
    const nightlySelection = readPluginCatalogSelection(
      {},
      { production: true, nightly: true },
      reviewedProductionPath,
      reviewedNightlyPath,
    );
    assert.strictEqual(nightlySelection.catalogPath, reviewedNightlyPath);
    assert.deepStrictEqual(nightlySelection.catalog, nightlyCatalog);
    assert.strictEqual(nightlySelection.localCandidate, false);
  });
}
function assertLatestStableReleaseSelection() {
  const catalog = syntheticCatalog();
  const catalogIds = catalog.packages.map((plugin) => plugin.pluginId);
  assert.deepStrictEqual(parseArguments([]), { latest: false, production: false, nightly: false });
  assert.deepStrictEqual(parseArguments(["--latest"]), {
    latest: true,
    production: false,
    nightly: false,
  });
  assert.deepStrictEqual(parseArguments(["--production"]), {
    latest: false,
    production: true,
    nightly: false,
  });
  assert.deepStrictEqual(parseArguments(["--production", "--nightly"]), {
    latest: false,
    production: true,
    nightly: true,
  });
  assert.throws(() => parseArguments(["--nightly"]), /requires --production/);
  assert.throws(() => parseArguments(["--latest", "--nightly"]), /requires --production/);
  assert.throws(() => parseArguments(["--production", "--nightly", "--nightly"]), /only once/);
  assert.throws(() => parseArguments(["--latest", "--latest"]), /only once/);
  assert.throws(() => parseArguments(["--production", "--production"]), /only once/);
  assert.throws(() => parseArguments(["--latest", "--production"]), /one release selection mode/);
  assert.throws(() => parseArguments(["--main"]), /Unsupported/);
  assert(compareStableVersions("0.10.0", "0.9.99") > 0);
  assert(compareStableVersions("10.0.0", "2.99.99") > 0);
  assert.strictEqual(compareStableVersions("1.2.3", "1.2.3"), 0);
  const latest = parseLatestStablePluginRelease(
    [
      `${"1".repeat(40)}\trefs/tags/v0.1.0`,
      `${"2".repeat(40)}\trefs/tags/v0.10.0`,
      `${"3".repeat(40)}\trefs/tags/v1.0.0-rc.1`,
      `${"4".repeat(40)}\trefs/tags/plugins-v99`,
      `${"5".repeat(40)}\trefs/heads/v99.0.0`,
    ].join("\n"),
  );
  assert.deepStrictEqual(latest, {
    ref: "refs/tags/v0.10.0",
    commit: "2".repeat(40),
  });
  const annotated = parseLatestStablePluginRelease(
    [`${"a".repeat(40)}\trefs/tags/v2.0.0`, `${"b".repeat(40)}\trefs/tags/v2.0.0^{}`].join("\n"),
  );
  assert.deepStrictEqual(annotated, {
    ref: "refs/tags/v2.0.0",
    commit: "b".repeat(40),
  });
  assert.throws(() => parseLatestStablePluginRelease(""), /no stable/);
  assert.throws(
    () =>
      parseLatestStablePluginRelease(
        [`${"a".repeat(40)}\trefs/tags/v1.0.0`, `${"b".repeat(40)}\trefs/tags/v1.0.0`].join("\n"),
      ),
    /ambiguously/,
  );
  const emptyInput = readPluginSourceEnvironment({});
  let resolverCalls = 0;
  const automatic = selectPluginSourceInput(
    emptyInput,
    { latest: true },
    (repository) => {
      resolverCalls += 1;
      assert.strictEqual(repository, CANONICAL_PLUGIN_REPOSITORY_URL);
      return { repository, ref: "refs/tags/v1.2.3", commit: "c".repeat(40) };
    },
    catalog,
  );
  assert.strictEqual(resolverCalls, 1);
  assert.strictEqual(automatic.ref, "refs/tags/v1.2.3");
  assert.strictEqual(automatic.commit, "c".repeat(40));
  assert.deepStrictEqual(automatic.selectedIds, catalogIds);
  const explicit = readPluginSourceEnvironment({
    TRITONAI_PLUGINS_REF: "refs/tags/v1.2.3",
    TRITONAI_PLUGINS_COMMIT: "d".repeat(40),
    TRITONAI_PLUGIN_IDS: "zeta-reader",
  });
  assert.strictEqual(
    selectPluginSourceInput(explicit, { latest: true }, () => {
      throw new Error("must not resolve latest");
    }),
    explicit,
  );
  assert.throws(
    () => selectPluginSourceInput({ ...explicit, commit: "" }, { latest: true }),
    /--latest does not complete partial managed plugin pins/,
  );
  const production = selectPluginSourceInput(
    emptyInput,
    { latest: false, production: true },
    undefined,
    catalog,
  );
  assert.deepStrictEqual(production.selectedIds, catalogIds);
  assert.throws(
    () => selectPluginSourceInput(explicit, { latest: false, production: true }),
    /source overrides must be unset/,
  );
}
function assertReviewedPluginCatalog() {
  const nightlyCatalog = readManagedPluginCatalog(nightlyPluginCatalogPath);
  assert.strictEqual(validateManagedPluginCatalog(nightlyCatalog), nightlyCatalog);
  const catalog = readManagedPluginCatalog(managedPluginCatalogPath);
  assert.strictEqual(validateManagedPluginCatalog(catalog), catalog);
  const composition = {
    version: 1,
    kind: "tritonai-harness-plugin-composition",
    source: { ...catalog.source },
    packages: catalog.packages.map((plugin) => ({
      id: plugin.pluginId,
      name: `@tritonai/plugin-${plugin.pluginId}`,
      version: plugin.version,
      digest: plugin.digest,
      files: [
        {
          path: ".tritonai-plugin/plugin.json",
          sha256: plugin.manifestDigest,
          size: 1,
        },
      ],
    })),
  };
  assert.strictEqual(assertCatalogComposition(catalog, composition), composition);
  assert.throws(
    () =>
      assertCatalogComposition(catalog, {
        ...composition,
        packages: composition.packages.map((plugin, index) =>
          index === 0 ? { ...plugin, digest: "f".repeat(64) } : plugin,
        ),
      }),
    /catalog digests/,
  );
  assert.throws(
    () => validateManagedPluginCatalog({ ...catalog, unexpected: true }),
    /unsupported fields/,
  );
  assert.throws(
    () =>
      validateManagedPluginCatalog({
        ...catalog,
        packages: catalog.packages.map((plugin, index) =>
          index === 0 ? { ...plugin, required: true } : plugin,
        ),
      }),
    /unsupported fields/,
  );
  assert.throws(
    () =>
      validateManagedPluginCatalog({
        ...catalog,
        packages: catalog.packages.map((plugin, index) =>
          index === 0 ? { ...plugin, artifactDescriptorDigest: "a".repeat(64) } : plugin,
        ),
      }),
    /unsupported fields/,
  );
  assert.throws(
    () =>
      validateManagedPluginCatalog({
        ...catalog,
        packages: [...catalog.packages].reverse(),
      }),
    /sorted stable ids/,
  );
}
function assertSafeCompositionPaths() {
  for (const relative of [
    "dist/index.js",
    ".tritonai-plugin/plugin.json",
    "skills/graph/SKILL.md",
  ]) {
    assert.strictEqual(isSafeRelativePath(relative), true);
  }
  for (const unsafe of [
    "../escape",
    "dist/../escape",
    "/absolute",
    "C:/absolute",
    "dist\\index.js",
    "dist//index.js",
    "./package.json",
  ]) {
    assert.strictEqual(isSafeRelativePath(unsafe), false, unsafe);
  }
}
function assertCanonicalProvenance() {
  for (const repository of [
    CANONICAL_PLUGIN_REPOSITORY_URL,
    "ssh://git@github.com/dbalders/TritonAI-Plugins.git",
    "git@github.com:dbalders/TritonAI-Plugins.git",
  ]) {
    assert.strictEqual(assertCanonicalPluginRepository(repository), "dbalders/TritonAI-Plugins");
  }
  for (const repository of [
    "https://github.com/dbalders/TritonAI-Plugin.git",
    "https://github.com.evil.example/dbalders/TritonAI-Plugins.git",
    "https://gitlab.com/dbalders/TritonAI-Plugins.git",
    "file:///tmp/TritonAI-Plugins",
    "/tmp/TritonAI-Plugins",
  ]) {
    assert.throws(
      () => assertCanonicalPluginRepository(repository),
      /not accepted as managed plugin provenance/,
    );
  }
  assert.throws(
    () =>
      assertCanonicalPluginRepository(
        "https://secret@github.com/dbalders/TritonAI-Plugins.git?token=private",
      ),
    (error) => !error.message.includes("secret") && !error.message.includes("private"),
  );
  assert.throws(
    () =>
      assertCanonicalPluginRepository(
        "https://build-token@github.com:bad/dbalders/TritonAI-Plugins.git",
      ),
    (error) =>
      !error.message.includes("build-token") && error.message.includes("invalid-repository-url"),
  );
}
function assertImmutableCommitSource() {
  withTempRoot("tritonai-immutable-source-", (sourceRoot) => {
    execFileSync("git", ["init", "-q"], { cwd: sourceRoot });
    const commitFile = (text) => {
      fs.writeFileSync(path.join(sourceRoot, "file"), text);
      execFileSync("git", ["add", "file"], { cwd: sourceRoot });
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", text],
        { cwd: sourceRoot },
      );
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: sourceRoot,
        encoding: "utf8",
      }).trim();
    };
    const pinned = commitFile("pinned");
    commitFile("branch advanced");
    assertRemoteRefResolvesToCommit(sourceRoot, pinned, pinned);
    assert.throws(
      () => assertRemoteRefResolvesToCommit(sourceRoot, pinned, COMMIT),
      /does not match/,
    );
    assert.throws(
      () => assertRemoteRefResolvesToCommit(sourceRoot, COMMIT, COMMIT),
      /Could not verify/,
    );
    const catalog = syntheticCatalog();
    catalog.source.ref = catalog.source.commit = pinned;
    validateManagedPluginCatalog(catalog);
    validateSourceInput({ ...catalog.source, selectedIds: ["alpha-reader"] });
    assert.throws(
      () =>
        validateManagedPluginCatalog({ ...catalog, source: { ...catalog.source, commit: COMMIT } }),
      /must match/,
    );
    assert.throws(
      () =>
        validateSourceInput({ ...catalog.source, commit: COMMIT, selectedIds: ["alpha-reader"] }),
      /must match/,
    );
  });
}
function assertExplicitSourceContract() {
  assert.deepStrictEqual(parseSelectedPluginIds("zeta-reader,alpha-reader"), [
    "alpha-reader",
    "zeta-reader",
  ]);
  assert.throws(() => parseSelectedPluginIds("alpha-reader,alpha-reader"), /duplicate/);
  assert.throws(() => parseSelectedPluginIds("../escape"), /invalid plugin id/);
  const environment = readPluginSourceEnvironment({
    TRITONAI_PLUGINS_REF: "refs/tags/plugins-v1",
    TRITONAI_PLUGINS_COMMIT: COMMIT,
    TRITONAI_PLUGIN_IDS: "alpha-reader",
  });
  assert.strictEqual(environment.repository, CANONICAL_PLUGIN_REPOSITORY_URL);
  assert.strictEqual(environment.localSource, "", "nearby checkouts must never be inferred");
  assert.deepStrictEqual(environment.selectedIds, ["alpha-reader"]);
  assert.throws(() => validateSourceInput({ ...environment, ref: "" }), /TRITONAI_PLUGINS_REF/);
  assert.throws(
    () => validateSourceInput({ ...environment, ref: "plugins-v1" }),
    /TRITONAI_PLUGINS_REF/,
  );
  assert.throws(
    () => validateSourceInput({ ...environment, commit: "main" }),
    /TRITONAI_PLUGINS_COMMIT/,
  );
  assert.throws(
    () => validateSourceInput({ ...environment, selectedIds: [] }),
    /TRITONAI_PLUGIN_IDS/,
  );
}
function assertPinnedGitMaterializationIncludesSdkArtifact() {
  withTempRoot("tritonai-sdk-plugin-git-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const targetRoot = path.join(tempRoot, "target");
    const expected = writeSdkPluginArtifact(sourceRoot, "sdk-reader", "1.0.0");
    execFileSync("git", ["init", "-q"], { cwd: sourceRoot });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: sourceRoot });
    execFileSync("git", ["config", "user.name", "Installer Test"], { cwd: sourceRoot });
    execFileSync("git", ["add", "plugins", "artifacts"], { cwd: sourceRoot });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: sourceRoot });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["clone", "-q", "--no-checkout", sourceRoot, targetRoot]);
    materializeSelectedPluginTrees(targetRoot, commit, ["sdk-reader"]);
    for (const [relative, contents] of expected) {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(targetRoot, "artifacts", "sdk-reader", relative)),
        contents,
      );
    }
    assert(fs.existsSync(path.join(targetRoot, "plugins", "sdk-reader", "package.json")));
  });
}
function assertDeterministicSelectionAndStaging() {
  withTempRoot("tritonai-plugin-stage-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "zeta-reader", "1.2.3");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    fs.mkdirSync(path.join(sourceRoot, "plugins", "alpha-reader", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "plugins", "alpha-reader", "src", "provider.ts"),
      "not packaged\n",
    );
    fs.mkdirSync(path.join(sourceRoot, "plugins", "alpha-reader", "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, "plugins", "alpha-reader", "tests", "provider.test.ts"),
      "not packaged\n",
    );
    const first = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader", "zeta-reader"],
      source: sourceIdentity(),
    });
    assert.deepStrictEqual(
      first.packages.map((plugin) => plugin.id),
      ["alpha-reader", "zeta-reader"],
    );
    assert(!fs.existsSync(path.join(vendorDir, "packages", "alpha-reader", "src")));
    assert(!fs.existsSync(path.join(vendorDir, "packages", "alpha-reader", "tests")));
    const persisted = JSON.parse(fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8"));
    assert.deepStrictEqual(persisted, first);
    assert.strictEqual(validateManagedPluginBundleManifest(persisted), persisted);
    const firstBytes = fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8");
    const second = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader", "zeta-reader"],
      source: sourceIdentity(),
    });
    assert.deepStrictEqual(second, first);
    assert.strictEqual(fs.readFileSync(path.join(vendorDir, "manifest.json"), "utf8"), firstBytes);
  });
}
function assertCatalogValidationPrecedesActivation() {
  withTempRoot("tritonai-plugin-catalog-transaction-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const compositionRequirementPath = path.join(
      tempRoot,
      "build",
      "managed-plugin-composition.json",
    );
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity(),
      compositionRequirementPath,
    });
    const previousManifest = fs.readFileSync(path.join(vendorDir, "manifest.json"));
    const previousSkill = fs.readFileSync(
      path.join(vendorDir, "packages", "alpha-reader", "skills", "alpha-reader", "SKILL.md"),
    );
    const previousRequirement = fs.readFileSync(compositionRequirementPath);
    assert.throws(
      () =>
        stagePluginsFromSource({
          sourceRoot,
          vendorDir,
          selectedIds: ["alpha-reader"],
          source: sourceIdentity(),
          compositionRequirementPath,
          assertComposition: () => {
            throw new Error("simulated catalog mismatch");
          },
        }),
      /simulated catalog mismatch/,
    );
    assert.deepStrictEqual(
      fs.readFileSync(path.join(vendorDir, "manifest.json")),
      previousManifest,
      "catalog rejection must preserve the previous vendor manifest",
    );
    assert.deepStrictEqual(
      fs.readFileSync(
        path.join(vendorDir, "packages", "alpha-reader", "skills", "alpha-reader", "SKILL.md"),
      ),
      previousSkill,
      "catalog rejection must preserve the previous vendor payloads",
    );
    assert.deepStrictEqual(
      fs.readFileSync(compositionRequirementPath),
      previousRequirement,
      "catalog rejection must preserve the previous composition requirement",
    );
  });
}
function assertProviderPackageStaging() {
  withTempRoot("tritonai-provider-plugin-stage-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeProviderPlugin(sourceRoot, "provider-reader", "1.0.0");
    const composition = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["provider-reader"],
      source: sourceIdentity(),
    });
    assert.deepStrictEqual(
      composition.packages[0].files.map(({ path: relative }) => relative),
      [
        ".tritonai-plugin/plugin.json",
        "README.md",
        "SECURITY.md",
        "dist/index.d.ts",
        "dist/index.js",
        "package.json",
        "skills/provider-reader/SKILL.md",
      ],
    );
    const stagedPackage = JSON.parse(
      fs.readFileSync(path.join(vendorDir, "packages", "provider-reader", "package.json"), "utf8"),
    );
    assert.deepStrictEqual(stagedPackage.exports["."], {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    fs.rmSync(path.join(sourceRoot, "plugins", "provider-reader", "dist", "index.d.ts"));
    assert.throws(
      () =>
        stagePluginsFromSource({
          sourceRoot,
          vendorDir,
          selectedIds: ["provider-reader"],
          source: sourceIdentity(),
        }),
      /composed package is missing dist\/index\.d\.ts/,
    );
  });
}
function assertSdkArtifactPassThrough() {
  withTempRoot("tritonai-sdk-plugin-stage-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const expected = writeSdkPluginArtifact(sourceRoot, "sdk-reader", "1.0.0");
    const composition = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["sdk-reader"],
      source: sourceIdentity(),
    });
    const stagedRoot = path.join(vendorDir, "packages", "sdk-reader");
    assert.deepStrictEqual(
      composition.packages[0].files.map(({ path: relative }) => relative),
      [...expected.keys()].sort(),
    );
    for (const [relative, contents] of expected) {
      assert.deepStrictEqual(fs.readFileSync(path.join(stagedRoot, relative)), contents);
    }
    assert(!fs.existsSync(path.join(stagedRoot, "package.json")));
    assert(!fs.existsSync(path.join(stagedRoot, "README.md")));
    fs.rmSync(path.join(sourceRoot, "artifacts", "sdk-reader", "plugin.mjs"));
    assert.throws(
      () =>
        stagePluginsFromSource({
          sourceRoot,
          vendorDir,
          selectedIds: ["sdk-reader"],
          source: sourceIdentity(),
        }),
      /sealed SDK artifact is missing plugin\.mjs/,
    );
  });
}
function assertRejectsUnsafePackages() {
  withTempRoot("tritonai-plugin-reject-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    const packageFile = path.join(sourceRoot, "plugins", "alpha-reader", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    packageJson.files.push("src");
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    assert.throws(
      () =>
        stagePluginsFromSource({
          sourceRoot,
          vendorDir,
          selectedIds: ["alpha-reader"],
          source: sourceIdentity(),
        }),
      /allowlist includes source/,
    );
    packageJson.files = packageJson.files.filter((entry) => entry !== "src");
    packageJson.files.push("assets");
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    assert.throws(
      () =>
        stagePluginsFromSource({
          sourceRoot,
          vendorDir,
          selectedIds: ["alpha-reader"],
          source: sourceIdentity(),
        }),
      /unsupported entry assets/,
    );
    packageJson.files = packageJson.files.filter((entry) => entry !== "assets");
    packageJson.version = "2.0.0";
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    assert.throws(
      () =>
        stagePluginsFromSource({
          sourceRoot,
          vendorDir,
          selectedIds: ["alpha-reader"],
          source: sourceIdentity(),
        }),
      /package\/manifest version drift/,
    );
    packageJson.version = "1.0.0";
    fs.writeFileSync(packageFile, JSON.stringify(packageJson));
    const nestedModules = path.join(
      sourceRoot,
      "plugins",
      "alpha-reader",
      "skills",
      "alpha-reader",
      "node_modules",
    );
    fs.mkdirSync(nestedModules, { recursive: true });
    fs.writeFileSync(path.join(nestedModules, "injected.js"), "injected\n");
    assert.throws(
      () =>
        stagePluginsFromSource({
          sourceRoot,
          vendorDir,
          selectedIds: ["alpha-reader"],
          source: sourceIdentity(),
        }),
      /cannot contain node_modules content/,
    );
    fs.rmSync(nestedModules, { recursive: true, force: true });
    const link = path.join(
      sourceRoot,
      "plugins",
      "alpha-reader",
      "skills",
      "alpha-reader",
      "linked.md",
    );
    try {
      fs.symlinkSync("SKILL.md", link);
      assert.throws(
        () =>
          stagePluginsFromSource({
            sourceRoot,
            vendorDir,
            selectedIds: ["alpha-reader"],
            source: sourceIdentity(),
          }),
        /symbolic links/,
      );
    } catch (error) {
      if (!error || !["EPERM", "EACCES"].includes(error.code)) throw error;
    }
    const badManifest = pluginManifest("alpha-reader", "1.0.0");
    badManifest.unsupported = true;
    assert.throws(() => validatePluginManifest(badManifest, "alpha-reader"), /unsupported fields/);
    const legacyRange = pluginManifest("alpha-reader", "1.0.0");
    legacyRange.compatibility = { harness: { min: "0.2.0", maxExclusive: "0.3.0" } };
    assert.throws(() => validatePluginManifest(legacyRange, "alpha-reader"), /unsupported fields/);
    const previousContract = pluginManifest("alpha-reader", "1.0.0");
    previousContract.apiVersion = "tritonai.harness/v1";
    previousContract.manifestVersion = 1;
    assert.throws(
      () => validatePluginManifest(previousContract, "alpha-reader"),
      /unsupported Harness/,
    );
    const legacyCapability = pluginManifest("alpha-reader", "1.0.0");
    legacyCapability.skills[0].capability = legacyCapability.skills[0].capabilities[0];
    delete legacyCapability.skills[0].capabilities;
    assert.throws(
      () => validatePluginManifest(legacyCapability, "alpha-reader"),
      /unsupported fields/,
    );
    const missingAccess = pluginManifest("alpha-reader", "1.0.0");
    delete missingAccess.capabilities[0].access;
    assert.throws(() => validatePluginManifest(missingAccess, "alpha-reader"), /capabilities/);
  });
}
function assertAtomicVendorRollback() {
  withTempRoot("tritonai-plugin-rollback-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(vendorDir, "previous"), "owned previous vendor\n");
    const originalRename = fs.renameSync;
    let failed = false;
    fs.renameSync = (source, target) => {
      if (
        !failed &&
        target === vendorDir &&
        path.basename(source).startsWith(".managed-plugins-vendor-")
      ) {
        failed = true;
        throw new Error("simulated plugin vendor activation failure");
      }
      return originalRename(source, target);
    };
    try {
      assert.throws(
        () =>
          stagePluginsFromSource({
            sourceRoot,
            vendorDir,
            selectedIds: ["alpha-reader"],
            source: sourceIdentity(),
          }),
        /simulated plugin vendor activation failure/,
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.strictEqual(
      fs.readFileSync(path.join(vendorDir, "previous"), "utf8"),
      "owned previous vendor\n",
    );
    const originalRenameForInitialFailure = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (source === vendorDir) throw new Error("simulated previous vendor move failure");
      return originalRenameForInitialFailure(source, target);
    };
    try {
      assert.throws(
        () =>
          stagePluginsFromSource({
            sourceRoot,
            vendorDir,
            selectedIds: ["alpha-reader"],
            source: sourceIdentity(),
          }),
        /simulated previous vendor move failure/,
      );
    } finally {
      fs.renameSync = originalRenameForInitialFailure;
    }
    assert.strictEqual(
      fs.readFileSync(path.join(vendorDir, "previous"), "utf8"),
      "owned previous vendor\n",
      "a failed initial rename must preserve the previous vendor",
    );
    const originalRenameForRollbackFailure = fs.renameSync;
    let activationFailed = false;
    fs.renameSync = (source, target) => {
      if (
        !activationFailed &&
        target === vendorDir &&
        path.basename(source).startsWith(".managed-plugins-vendor-")
      ) {
        activationFailed = true;
        throw new Error("simulated plugin vendor activation failure");
      }
      if (activationFailed && target === vendorDir && path.basename(source) === "previous-vendor") {
        throw new Error("simulated plugin vendor rollback failure");
      }
      return originalRenameForRollbackFailure(source, target);
    };
    try {
      assert.throws(
        () =>
          stagePluginsFromSource({
            sourceRoot,
            vendorDir,
            selectedIds: ["alpha-reader"],
            source: sourceIdentity(),
          }),
        /rollback failed: simulated plugin vendor rollback failure; previous release state kept at .*\.managed-plugins-vendor-backup-/,
      );
    } finally {
      fs.renameSync = originalRenameForRollbackFailure;
    }
    const preservedBackup = fs
      .readdirSync(path.dirname(vendorDir))
      .find((name) => name.startsWith(".managed-plugins-vendor-backup-"));
    assert(
      preservedBackup,
      "a rollback failure must preserve the previous plugin vendor for recovery",
    );
    fs.renameSync(
      path.join(path.dirname(vendorDir), preservedBackup, "previous-vendor"),
      vendorDir,
    );
  });
}
function assertAtomicRequirementRollback() {
  withTempRoot("tritonai-plugin-requirement-rollback-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const compositionRequirementPath = path.join(
      tempRoot,
      "build",
      "managed-plugin-composition.json",
    );
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity(),
      compositionRequirementPath,
    });
    const previousManifest = fs.readFileSync(path.join(vendorDir, "manifest.json"));
    const previousRequirement = fs.readFileSync(compositionRequirementPath);
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.1");
    const originalRename = fs.renameSync;
    const originalRemove = fs.rmSync;
    let previousRequirementMoved = false;
    let failed = false;
    fs.renameSync = (source, target) => {
      if (source === compositionRequirementPath) previousRequirementMoved = true;
      if (previousRequirementMoved && !failed && target === compositionRequirementPath) {
        failed = true;
        throw new Error("simulated composition requirement activation failure");
      }
      return originalRename(source, target);
    };
    fs.rmSync = (target, options) => {
      if (target === vendorDir || target === compositionRequirementPath) {
        throw new Error("rollback must not destructively remove live release state");
      }
      return originalRemove(target, options);
    };
    try {
      assert.throws(
        () =>
          stagePluginsFromSource({
            sourceRoot,
            vendorDir,
            selectedIds: ["alpha-reader"],
            source: sourceIdentity(),
            compositionRequirementPath,
          }),
        /simulated composition requirement activation failure/,
      );
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync = originalRemove;
    }
    assert.deepStrictEqual(
      fs.readFileSync(path.join(vendorDir, "manifest.json")),
      previousManifest,
      "requirement activation failure must restore the previous plugin vendor",
    );
    assert.deepStrictEqual(
      fs.readFileSync(compositionRequirementPath),
      previousRequirement,
      "requirement activation failure must restore the previous requirement marker",
    );
  });
}
function assertRollbackQuarantineFailurePreservesOneGeneration() {
  withTempRoot("tritonai-plugin-quarantine-rollback-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    const requirementPath = path.join(tempRoot, "build", "managed-plugin-composition.json");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity(),
      compositionRequirementPath: requirementPath,
    });
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.1");
    const originalRename = fs.renameSync;
    let previousRequirementMoved = false;
    fs.renameSync = (source, target) => {
      if (source === requirementPath) previousRequirementMoved = true;
      if (previousRequirementMoved && target === requirementPath) {
        throw new Error("simulated requirement activation failure");
      }
      if (source === vendorDir && path.basename(target) === "failed-vendor") {
        throw new Error("simulated vendor quarantine failure");
      }
      return originalRename(source, target);
    };
    try {
      assert.throws(
        () =>
          stagePluginsFromSource({
            sourceRoot,
            vendorDir,
            selectedIds: ["alpha-reader"],
            source: sourceIdentity(),
            compositionRequirementPath: requirementPath,
          }),
        /rollback failed: simulated vendor quarantine failure/,
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.strictEqual(
      fs.existsSync(requirementPath),
      false,
      "failed rollback must stay fail closed",
    );
    const backup = fs
      .readdirSync(path.dirname(vendorDir))
      .find((name) => name.startsWith(".managed-plugins-vendor-backup-"));
    assert(backup, "failed rollback must preserve its complete previous generation");
    const backupRoot = path.join(path.dirname(vendorDir), backup);
    assert(fs.existsSync(path.join(backupRoot, "previous-vendor", "manifest.json")));
    assert(fs.existsSync(path.join(backupRoot, "previous-requirement.json")));
  });
}
function assertCompositionContract() {
  withTempRoot("tritonai-plugin-composition-", (tempRoot) => {
    const sourceRoot = path.join(tempRoot, "source");
    const vendorDir = path.join(tempRoot, "vendor", "plugins");
    writeSkillPlugin(sourceRoot, "alpha-reader", "1.0.0");
    const expected = stagePluginsFromSource({
      sourceRoot,
      vendorDir,
      selectedIds: ["alpha-reader"],
      source: sourceIdentity(),
    });
    assert.deepStrictEqual(
      assertMatchingPluginComposition(expected, structuredClone(expected)),
      expected,
    );
    const reordered = reverseObjectKeys(expected);
    assert.deepStrictEqual(
      assertMatchingPluginComposition(expected, reordered),
      reordered,
      "composition matching must ignore JSON object key order at every schema level",
    );
    const artifact = {
      fileName: "TritonAI-Harness-0.2.7-arm64.dmg",
      sha512: `${"A".repeat(86)}==`,
      size: 1234,
    };
    const bound = { ...structuredClone(expected), artifacts: [artifact] };
    assert.deepStrictEqual(assertMatchingPluginComposition(expected, bound), bound);
    assert.deepStrictEqual(assertArtifactBinding(bound, artifact), artifact);
    assert.throws(
      () => assertArtifactBinding(bound, { ...artifact, size: artifact.size + 1 }),
      /not bound to the exact/,
    );
    const legacyRange = structuredClone(expected);
    legacyRange.packages[0].compatibility = { harness: { min: "0.3.0", maxExclusive: "0.4.0" } };
    assert.throws(() => validateManagedPluginBundleManifest(legacyRange), /unsupported fields/);
    const drifted = structuredClone(expected);
    drifted.packages[0].version = "1.0.1";
    assert.throws(
      () => assertMatchingPluginComposition(expected, drifted),
      /does not match the exact prepared/,
    );
  });
}
function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}
function writeSkillPlugin(sourceRoot, id, version) {
  const packageRoot = path.join(sourceRoot, "plugins", id);
  fs.mkdirSync(path.join(packageRoot, ".tritonai-plugin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "skills", id), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "README.md"), `# ${id}\n`);
  fs.writeFileSync(path.join(packageRoot, "SECURITY.md"), "# Security\n");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: `@tritonai/plugin-${id}`,
        version,
        files: [".tritonai-plugin", "skills", "README.md", "SECURITY.md"],
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, ".tritonai-plugin", "plugin.json"),
    `${JSON.stringify(pluginManifest(id, version), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(packageRoot, "skills", id, "SKILL.md"),
    `---\nname: ${id}\ndescription: Read ${id} data.\n---\n# ${id}\n`,
  );
}
function writeProviderPlugin(sourceRoot, id, version) {
  writeSkillPlugin(sourceRoot, id, version);
  const packageRoot = path.join(sourceRoot, "plugins", id);
  const packageFile = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  packageJson.files.push("dist");
  packageJson.exports = {
    ".": {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
  };
  fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
  const manifestFile = path.join(packageRoot, ".tritonai-plugin", "plugin.json");
  const manifest = pluginManifest(id, version);
  manifest.provider = `${id}.provider`;
  manifest.tools = [
    {
      name: `${id}.records.list`,
      displayName: "List records",
      description: "List bounded records.",
      capabilities: [`${id}.read`],
      effect: "read",
    },
  ];
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const distributionRoot = path.join(packageRoot, "dist");
  fs.mkdirSync(distributionRoot, { recursive: true });
  fs.writeFileSync(
    path.join(distributionRoot, "index.js"),
    "export const manifest = {}; export function createIntegrationProvider() { return {}; }\n",
  );
  fs.writeFileSync(
    path.join(distributionRoot, "index.d.ts"),
    "export declare const manifest: unknown; export declare function createIntegrationProvider(input: unknown): unknown;\n",
  );
}
function writeSdkPluginArtifact(sourceRoot, id, version) {
  const packageRoot = path.join(sourceRoot, "plugins", id);
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "README.md"), "Source documentation is not staged.\n");
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: `@tritonai/plugin-${id}`, version, private: true }, null, 2)}\n`,
  );
  const artifactRoot = path.join(sourceRoot, "artifacts", id);
  const files = new Map([
    [
      "artifact.json",
      Buffer.from('{"artifactVersion":1,"format":"tritonai.plugin-artifact/v1"}\n'),
    ],
    [
      ".tritonai-plugin/plugin.json",
      Buffer.from(`{"apiVersion":"tritonai.plugin/v1","id":"${id}","version":"${version}"}\n`),
    ],
    [
      "plugin.mjs",
      Buffer.from('throw new Error("Installer must not import sealed plugin code");\n'),
    ],
    [
      `skills/${id}/SKILL.md`,
      Buffer.from(`---\nname: ${id}\ndescription: Read sealed fixture data.\n---\n`),
    ],
  ]);
  for (const [relative, contents] of files) {
    const target = path.join(artifactRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return files;
}
function syntheticCatalog() {
  return validateManagedPluginCatalog({
    version: 1,
    kind: "tritonai-managed-plugin-catalog",
    source: {
      repository: CANONICAL_PLUGIN_REPOSITORY_URL,
      ref: "refs/tags/v1.2.3",
      commit: "e".repeat(40),
    },
    packages: ["alpha-reader", "zeta-reader"].map((pluginId) => ({
      pluginId,
      version: "1.0.0",
      digest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
    })),
  });
}
function pluginManifest(id, version) {
  return {
    apiVersion: "tritonai.harness/v2",
    kind: "IntegrationPlugin",
    manifestVersion: 2,
    id,
    name: id,
    description: `Read ${id} data.`,
    version,
    capabilities: [
      { id: `${id}.read`, displayName: "Read", description: "Read data.", access: "default" },
    ],
    tools: [],
    skills: [{ name: id, description: `Read ${id} data.`, capabilities: [`${id}.read`] }],
  };
}
function sourceIdentity() {
  return {
    repository: CANONICAL_PLUGIN_REPOSITORY_URL,
    ref: "refs/tags/plugins-v1",
    commit: COMMIT,
  };
}
function withTempRoot(prefix, callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    callback(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
test("canonical provenance", assertCanonicalProvenance);
test("reviewed plugin catalog", assertReviewedPluginCatalog);
test("local candidate catalog selection", assertLocalCandidateCatalogSelection);
test("latest stable release selection", assertLatestStableReleaseSelection);
test("explicit source contract", assertExplicitSourceContract);
test("immutable commit source", assertImmutableCommitSource);
test(
  "pinned git materialization includes sdk artifact",
  assertPinnedGitMaterializationIncludesSdkArtifact,
);
test("deterministic selection and staging", assertDeterministicSelectionAndStaging);
test("catalog validation precedes activation", assertCatalogValidationPrecedesActivation);
test("provider package staging", assertProviderPackageStaging);
test("sdk artifact pass through", assertSdkArtifactPassThrough);
test("rejects unsafe packages", assertRejectsUnsafePackages);
test("atomic vendor rollback", assertAtomicVendorRollback);
test("atomic requirement rollback", assertAtomicRequirementRollback);
test(
  "rollback quarantine failure preserves one generation",
  assertRollbackQuarantineFailurePreservesOneGeneration,
);
test("composition contract", assertCompositionContract);
test("safe composition paths", assertSafeCompositionPaths);
