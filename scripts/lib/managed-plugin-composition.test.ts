// @effect-diagnostics nodeBuiltinImport:off - Release contract tests use real temporary files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EFFECT_HOST_PEER_RANGE } from "@t3tools/shared/pluginHostRuntime";
import effectPackageJson from "effect/package.json" with { type: "json" };

import { finalizeManagedPluginProof } from "./finalize-managed-plugin-proof.ts";
import {
  managedPluginProofFileName,
  managedPluginProofInputFileName,
  readManagedPluginBuildConfiguration,
  readManagedPluginComposition,
  snapshotManagedPluginComposition,
} from "./managed-plugin-composition.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed plugin release composition", () => {
  it("accepts a novel plugin only when the exact release composition selects it", () => {
    const composition = readManagedPluginComposition(
      makeCompositionFixture(
        null,
        { peerDependencies: { effect: EFFECT_HOST_PEER_RANGE } },
        "future-provider",
      ),
    );
    expect(composition.packages).toMatchObject([
      {
        id: "future-provider",
        name: "@tritonai/plugin-future-provider",
        version: "1.0.1",
      },
    ]);
  });

  it("reads only an exact package-keyed generic build configuration", () => {
    const composition = readManagedPluginComposition(makeCompositionFixture());
    const serialized = JSON.stringify({
      "microsoft-365": {
        clientId: "11111111-1111-4111-8111-111111111111",
        tenantId: "22222222-2222-4222-8222-222222222222",
      },
    });
    expect(
      readManagedPluginBuildConfiguration(composition, {
        TRITONAI_PLUGIN_CONFIGURATION_JSON: serialized,
      }),
    ).toEqual(JSON.parse(serialized));

    for (const invalid of [
      "",
      "{",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ "microsoft-365": null }),
      JSON.stringify({ "microsoft-365": [], extra: {} }),
    ]) {
      expect(() =>
        readManagedPluginBuildConfiguration(composition, {
          TRITONAI_PLUGIN_CONFIGURATION_JSON: invalid,
        }),
      ).toThrow();
    }
    expect(() =>
      readManagedPluginBuildConfiguration(composition, {
        TRITONAI_PLUGIN_CONFIGURATION_JSON: JSON.stringify({
          "microsoft-365": { padding: "x".repeat(16 * 1024) },
        }),
      }),
    ).toThrow(/16384-byte limit/u);
  });

  it("snapshots one strict current composition contract and rejects manifest compatibility ranges", () => {
    const sourceRoot = makeCompositionFixture();
    const composition = readManagedPluginComposition(sourceRoot);
    const snapshotRoot = NodePath.join(makeTemporaryDirectory(), "snapshot");

    expect(snapshotManagedPluginComposition(sourceRoot, snapshotRoot)).toEqual(composition);

    const manifestPath = NodePath.join(sourceRoot, "manifest.json");
    const legacy = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const [plugin] = legacy.packages as Array<Record<string, unknown>>;
    if (!plugin) throw new Error("Managed plugin composition fixture is missing its package.");
    plugin.compatibility = { harness: { min: "0.3.0", maxExclusive: "0.4.0" } };
    NodeFS.writeFileSync(manifestPath, JSON.stringify(legacy));
    expect(() => readManagedPluginComposition(sourceRoot)).toThrow(/unsupported fields/iu);
  });

  it("accepts the released Effect build pin and the canonical forward-compatible peer contract", () => {
    expect(() =>
      readManagedPluginComposition(makeCompositionFixture("4.0.0-beta.78")),
    ).not.toThrow();
    expect(() =>
      readManagedPluginComposition(
        makeCompositionFixture(null, {
          peerDependencies: { effect: EFFECT_HOST_PEER_RANGE },
        }),
      ),
    ).not.toThrow();
  });

  it("accepts providerless packages without runtime metadata and rejects nonempty runtime metadata", () => {
    expect(() =>
      readManagedPluginComposition(
        makeCompositionFixture(null, {}, "skills-only", {}, { providerless: true }),
      ),
    ).not.toThrow();

    for (const packageRuntime of [
      { dependencies: { effect: "4.0.0-beta.78" } },
      { peerDependencies: { effect: EFFECT_HOST_PEER_RANGE } },
      { optionalDependencies: { effect: "4.0.0-beta.78" } },
      { bundledDependencies: ["effect"] },
      { bundleDependencies: ["effect"] },
    ]) {
      expect(() =>
        readManagedPluginComposition(
          makeCompositionFixture(
            null,
            packageRuntime,
            "skills-only",
            {},
            {
              providerless: true,
            },
          ),
        ),
      ).toThrow(/cannot declare runtime metadata without a provider/iu);
    }
  });

  it("rejects newer build pins, broad peers, and additional runtime dependencies", () => {
    for (const version of ["4.0.0-beta.79", effectPackageJson.version, "4.0.0-beta.999"]) {
      expect(() => readManagedPluginComposition(makeCompositionFixture(version))).toThrow(
        /incompatible host runtime contract/iu,
      );
    }
    expect(() =>
      readManagedPluginComposition(
        makeCompositionFixture(null, {
          peerDependencies: { effect: ">=4.0.0-beta.1 <5.0.0" },
        }),
      ),
    ).toThrow(/incompatible host runtime contract/iu);
    expect(() =>
      readManagedPluginComposition(
        makeCompositionFixture("4.0.0-beta.78", {
          dependencies: { effect: "4.0.0-beta.78", unexpected: "1.0.0" },
        }),
      ),
    ).toThrow(/incompatible host runtime contract/iu);
  });

  it("rejects symbolic links at both managed package directory boundaries", () => {
    for (const boundary of ["packages", "package"] as const) {
      const sourceRoot = makeCompositionFixture();
      const packagesRoot = NodePath.join(sourceRoot, "packages");
      const packageRoot = NodePath.join(packagesRoot, "microsoft-365");
      const replacedPath = boundary === "packages" ? packagesRoot : packageRoot;
      const externalPath = NodePath.join(makeTemporaryDirectory(), boundary);
      NodeFS.renameSync(replacedPath, externalPath);
      NodeFS.symlinkSync(externalPath, replacedPath, "dir");

      expect(() => readManagedPluginComposition(sourceRoot)).toThrow(/must be a real directory/iu);
    }
  });

  it("rejects package entries that are absent from the composition proof", () => {
    const sourceRoot = makeCompositionFixture();
    const unlistedRoot = NodePath.join(sourceRoot, "packages", "node_modules", "unproved-code");
    NodeFS.mkdirSync(unlistedRoot, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(unlistedRoot, "index.js"), "throw new Error('unproved');\n");

    expect(() => readManagedPluginComposition(sourceRoot)).toThrow(/unlisted entries/iu);
  });

  it("rejects composed inventory paths containing a node_modules segment before snapshotting", () => {
    for (const nodeModulesSegment of ["node_modules", "Node_Modules", "NODE_MODULES"]) {
      const sourceRoot = makeCompositionFixture("4.0.0-beta.78", {}, "microsoft-365", {
        [`dist/${nodeModulesSegment}/unproved-code/index.js`]: "throw new Error('unproved');\n",
      });
      const snapshotRoot = NodePath.join(makeTemporaryDirectory(), "snapshot");
      const markerPath = NodePath.join(snapshotRoot, "marker");
      NodeFS.mkdirSync(snapshotRoot);
      NodeFS.writeFileSync(markerPath, "untouched");

      expect(() => snapshotManagedPluginComposition(sourceRoot, snapshotRoot)).toThrow(
        /file paths must be safe/iu,
      );
      expect(NodeFS.readFileSync(markerPath, "utf8")).toBe("untouched");
    }
  });

  it("rejects deeply nested package directories without recursive traversal", () => {
    const sourceRoot = makeCompositionFixture();
    const packageRoot = NodePath.join(sourceRoot, "packages", "microsoft-365");
    const nestedDirectories = Array.from({ length: 257 }, () => "d");
    NodeFS.mkdirSync(NodePath.join(packageRoot, ...nestedDirectories), { recursive: true });

    expect(() => readManagedPluginComposition(sourceRoot)).toThrow(/directory limit/iu);
  });

  it("finalizes distinct macOS and Windows proofs from final artifact bytes", async () => {
    const sourceRoot = makeCompositionFixture();
    const composition = readManagedPluginComposition(sourceRoot);
    const outputDir = makeTemporaryDirectory();
    const targets = [
      { platform: "mac" as const, arch: "arm64", extension: "dmg" },
      { platform: "win" as const, arch: "x64", extension: "exe" },
    ];

    for (const target of targets) {
      const artifactPath = NodePath.join(
        outputDir,
        `TritonAI-Harness-0.3.0-${target.arch}.${target.extension}`,
      );
      NodeFS.writeFileSync(artifactPath, `final signed ${target.platform} bytes`);
      NodeFS.writeFileSync(
        NodePath.join(outputDir, managedPluginProofInputFileName(target.platform, target.arch)),
        JSON.stringify(composition),
      );

      const proofPath = await finalizeManagedPluginProof({
        platform: target.platform,
        arch: target.arch,
        artifactPath,
        outputDir,
      });
      const proof = JSON.parse(NodeFS.readFileSync(proofPath, "utf8")) as {
        readonly artifacts: ReadonlyArray<{
          readonly fileName: string;
          readonly sha512: string;
          readonly size: number;
        }>;
      };
      expect(NodePath.basename(proofPath)).toBe(
        managedPluginProofFileName(target.platform, target.arch),
      );
      expect(proof.artifacts).toEqual([
        {
          fileName: NodePath.basename(artifactPath),
          size: NodeFS.statSync(artifactPath).size,
          sha512: sha512(artifactPath),
        },
      ]);
      expect(
        NodeFS.existsSync(
          NodePath.join(outputDir, managedPluginProofInputFileName(target.platform, target.arch)),
        ),
      ).toBe(false);

      NodeFS.appendFileSync(artifactPath, "\npost-proof mutation");
      expect(proof.artifacts[0]?.sha512).not.toBe(sha512(artifactPath));
    }

    expect(managedPluginProofFileName("mac", "arm64")).not.toBe(
      managedPluginProofFileName("win", "x64"),
    );
  });
});

function makeTemporaryDirectory(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tritonai-composition-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeCompositionFixture(
  effectVersion: string | null = "4.0.0-beta.78",
  packageRuntime: Readonly<Record<string, unknown>> = {},
  pluginId = "microsoft-365",
  extraFiles: Readonly<Record<string, string>> = {},
  options: { readonly providerless?: boolean } = {},
): string {
  const sourceRoot = makeTemporaryDirectory();
  const packageRoot = NodePath.join(sourceRoot, "packages", pluginId);
  const google = pluginId === "google-workspace";
  const providerless = options.providerless === true;
  const files = new Map<string, string>([
    [
      ".tritonai-plugin/plugin.json",
      JSON.stringify({
        apiVersion: "tritonai.harness/v2",
        kind: "IntegrationPlugin",
        manifestVersion: 2,
        id: pluginId,
        name: google ? "Google Workspace" : "Microsoft 365",
        description: google
          ? "Use reviewed Google Workspace tools."
          : "Use reviewed Microsoft 365 tools.",
        version: "1.0.1",
        ...(providerless ? {} : { provider: google ? "google-workspace" : "microsoft-graph" }),
        capabilities: [
          {
            id: "mail.read",
            displayName: "Read mail",
            description: "Read mail metadata.",
            access: "default",
          },
        ],
        tools: providerless
          ? []
          : [
              {
                name: google ? "googleworkspace.mail.search" : "microsoft365.mail.search",
                displayName: "Search mail",
                description: "Search mail metadata.",
                capabilities: ["mail.read"],
                effect: "read",
              },
            ],
        skills: [
          {
            name: google ? "gmail" : "outlook-mail",
            description: google ? "Search Gmail." : "Search Outlook mail.",
            capabilities: ["mail.read"],
          },
        ],
      }),
    ],
    [
      "package.json",
      JSON.stringify({
        name: `@tritonai/plugin-${pluginId}`,
        version: "1.0.1",
        type: "module",
        ...(effectVersion === null ? {} : { dependencies: { effect: effectVersion } }),
        ...packageRuntime,
      }),
    ],
  ]);
  if (!providerless) {
    files.set(
      "dist/index.js",
      `export const provider = '${google ? "google-workspace" : "microsoft-graph"}';\n`,
    );
  }
  for (const [relativePath, contents] of Object.entries(extraFiles)) {
    files.set(relativePath, contents);
  }
  for (const [relativePath, contents] of files) {
    const target = NodePath.join(packageRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
  }
  const described = [...files]
    .map(([relativePath]) => {
      const contents = NodeFS.readFileSync(NodePath.join(packageRoot, relativePath));
      return { path: relativePath, size: contents.length, sha256: sha256(contents) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const digest = NodeCrypto.createHash("sha256");
  for (const file of described) {
    digest.update(file.path, "utf8");
    digest.update("\0");
    digest.update(String(file.size), "utf8");
    digest.update("\0");
    digest.update(NodeFS.readFileSync(NodePath.join(packageRoot, file.path)));
    digest.update("\0");
  }
  NodeFS.writeFileSync(
    NodePath.join(sourceRoot, "manifest.json"),
    JSON.stringify({
      version: 1,
      kind: "tritonai-harness-plugin-composition",
      source: {
        repository: "https://github.com/dbalders/TritonAI-Plugins.git",
        ref: "refs/tags/plugins-v1.0.1",
        commit: "a".repeat(40),
      },
      packages: [
        {
          id: pluginId,
          name: `@tritonai/plugin-${pluginId}`,
          version: "1.0.1",
          digest: digest.digest("hex"),
          files: described,
        },
      ],
    }),
  );
  return sourceRoot;
}

function sha256(contents: Buffer): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

function sha512(path: string): string {
  return NodeCrypto.createHash("sha512").update(NodeFS.readFileSync(path)).digest("base64");
}
