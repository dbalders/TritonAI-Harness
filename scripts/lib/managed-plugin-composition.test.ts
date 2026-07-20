// @effect-diagnostics nodeBuiltinImport:off - Release contract tests use real temporary files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { finalizeManagedPluginProof } from "./finalize-managed-plugin-proof.ts";
import {
  managedPluginProofFileName,
  managedPluginProofInputFileName,
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
  it("snapshots one strict current contract and rejects compatibility ranges", () => {
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

function makeCompositionFixture(): string {
  const sourceRoot = makeTemporaryDirectory();
  const packageRoot = NodePath.join(sourceRoot, "packages", "microsoft-365");
  const files = new Map<string, string>([
    [
      ".tritonai-plugin/plugin.json",
      JSON.stringify({
        apiVersion: "tritonai.harness/v2",
        kind: "IntegrationPlugin",
        manifestVersion: 2,
        id: "microsoft-365",
        name: "Microsoft 365",
        description: "Use reviewed Microsoft 365 tools.",
        version: "1.0.1",
        provider: "microsoft-graph",
        capabilities: [
          {
            id: "mail.read",
            displayName: "Read mail",
            description: "Read mail metadata.",
            access: "default",
          },
        ],
        tools: [
          {
            name: "microsoft365.mail.search",
            displayName: "Search mail",
            description: "Search mail metadata.",
            capabilities: ["mail.read"],
            effect: "read",
          },
        ],
        skills: [
          {
            name: "outlook-mail",
            description: "Search Outlook mail.",
            capabilities: ["mail.read"],
          },
        ],
      }),
    ],
    ["dist/index.js", "export const provider = 'microsoft-graph';\n"],
    [
      "package.json",
      JSON.stringify({ name: "@tritonai/plugin-microsoft-365", version: "1.0.1", type: "module" }),
    ],
  ]);
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
          id: "microsoft-365",
          name: "@tritonai/plugin-microsoft-365",
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
