// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { EFFECT_HOST_PEER_RANGE } from "@t3tools/shared/pluginHostRuntime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import effectPackageJson from "effect/package.json" with { type: "json" };

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { IntegrationPackage } from "./IntegrationRegistry.ts";
import {
  loadProductionPackageForTest,
  loadProductionPackagesForTest,
  verifyProductionPackageForTest,
  withProductionPackageSnapshotForTest,
} from "./productionBuiltins.ts";
import { validateIntegrationManifest } from "./manifest.ts";
import { PluginSdkQuarantineError } from "./pluginSdk/adapter.ts";

interface TestFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly contents: Uint8Array;
}

// Byte-for-byte from TritonAI-Plugins PR #20 commit 8fca1b7.
const sdkGoldenRoot = NodePath.join(
  import.meta.dirname,
  "pluginSdk",
  "test-fixtures",
  "synthetic-api-key",
);

function sha256(contents: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

function composition(files: ReadonlyArray<TestFile>, id = "future-provider") {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(String(file.size), "utf8");
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return {
    id,
    name: `@tritonai/plugin-${id}`,
    version: "1.0.0",
    digest: hash.digest("hex"),
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  };
}

async function testFiles(root: string): Promise<ReadonlyArray<TestFile>> {
  const files: Array<TestFile> = [];
  async function walk(current: string, relative = ""): Promise<void> {
    for (const entry of await NodeFSP.readdir(current, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = NodePath.join(current, entry.name);
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile()) {
        const contents = await NodeFSP.readFile(child);
        files.push({
          path: childRelative,
          sha256: sha256(contents),
          size: contents.byteLength,
          contents,
        });
      } else throw new Error(`Unexpected test fixture entry: ${childRelative}`);
    }
  }
  await walk(root);
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

async function fixture(
  effectVersion: string | null = "4.0.0-beta.78",
  packageRuntime: Readonly<Record<string, unknown>> = {},
  options: {
    readonly extraFiles?: ReadonlyArray<readonly [path: string, contents: string]>;
    readonly id?: string;
    readonly includeDistribution?: boolean;
    readonly manifest?: Readonly<Record<string, unknown>>;
    readonly moduleSource?: string;
  } = {},
) {
  const id = options.id ?? "future-provider";
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-production-plugin-"));
  const manifest = options.manifest ?? {
    apiVersion: "tritonai.harness/v2",
    kind: "IntegrationPlugin",
    manifestVersion: 2,
    id,
    name: "Future Provider",
    description: "Exercises the generic production provider factory.",
    version: "1.0.0",
    provider: "future-provider",
    capabilities: [
      {
        id: "records.read",
        displayName: "Read records",
        description: "Read bounded records.",
        access: "default",
      },
    ],
    tools: [
      {
        name: "future.records.list",
        displayName: "List records",
        description: "List bounded records.",
        capabilities: ["records.read"],
        effect: "read",
      },
    ],
    skills: [],
  };
  const moduleSource =
    options.moduleSource ??
    [
      'import * as Effect from "effect/Effect";',
      'import * as Option from "effect/Option";',
      'import manifest from "../.tritonai-plugin/plugin.json" with { type: "json" };',
      "export { manifest };",
      "export const value = Effect.succeed(true);",
      "export class FixtureProvider {",
      "  constructor(secrets, configuration) {",
      "    this.id = manifest.provider;",
      "    this.tools = [];",
      "    this.secrets = secrets;",
      "    this.configuration = configuration;",
      "  }",
      '  async status() { return { state: "not_connected", accountLabel: null, grantedCapabilities: [], message: null }; }',
      "  async invoke() { return null; }",
      "  async credential() {",
      '    const value = await Effect.runPromise(this.secrets.get("oauth"));',
      "    return Option.isSome(value) ? new TextDecoder().decode(value.value) : null;",
      "  }",
      "}",
      "export function createIntegrationProvider({ secrets, configuration }) {",
      "  return new FixtureProvider(secrets, configuration);",
      "}",
    ].join("\n");
  const entries: Array<readonly [path: string, contents: string]> = [
    [".tritonai-plugin/plugin.json", JSON.stringify(manifest)],
    [
      "package.json",
      JSON.stringify({
        name: `@tritonai/plugin-${id}`,
        version: "1.0.0",
        type: "module",
        ...(effectVersion === null ? {} : { dependencies: { effect: effectVersion } }),
        ...packageRuntime,
      }),
    ],
  ];
  if (options.includeDistribution !== false) {
    entries.push(["dist/index.js", moduleSource]);
  }
  entries.push(...(options.extraFiles ?? []));
  const files: Array<TestFile> = [];
  for (const [relative, value] of entries) {
    const contents = Buffer.from(value);
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, relative)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, relative), contents);
    files.push({ path: relative, sha256: sha256(contents), size: contents.byteLength, contents });
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { root, files, plugin: composition(files, id) };
}

function secretStore(names: string[] = []): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: (name) => {
      names.push(name);
      return Effect.succeed(Option.some(new TextEncoder().encode("host-secret")));
    },
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
    remove: () => Effect.void,
  };
}

function skillsOnlyManifest() {
  return {
    apiVersion: "tritonai.harness/v2",
    kind: "IntegrationPlugin",
    manifestVersion: 2,
    id: "future-provider",
    name: "Future Skills",
    description: "Exercises a providerless package.",
    version: "1.0.0",
    capabilities: [
      {
        id: "records.read",
        displayName: "Read records",
        description: "Read bounded records.",
        access: "default",
      },
    ],
    tools: [],
    skills: [
      {
        name: "future-records",
        description: "Read bounded records.",
        capabilities: ["records.read"],
      },
    ],
  };
}

describe("production built-in package verification", () => {
  it("loads a skills-only package without a provider distribution", async () => {
    const { root, plugin } = await fixture(
      null,
      {},
      {
        includeDistribution: false,
        manifest: skillsOnlyManifest(),
      },
    );
    try {
      const loaded = await loadProductionPackageForTest(root, plugin, secretStore(), {});
      expect(loaded.provider).toBeUndefined();
      expect(loaded.manifest.skills.map(({ name }) => name)).toEqual(["future-records"]);
      expect(Object.keys(loaded.bundledFiles ?? {}).toSorted()).toEqual([
        ".tritonai-plugin/plugin.json",
        "package.json",
      ]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects provider distribution files in a skills-only package", async () => {
    const { root, plugin } = await fixture(
      null,
      {},
      {
        manifest: skillsOnlyManifest(),
        moduleSource:
          'export function createIntegrationProvider() { throw new Error("must not execute"); }',
      },
    );
    try {
      await expect(loadProductionPackageForTest(root, plugin, secretStore(), {})).rejects.toThrow(
        "includes provider distribution files without declaring a provider",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects runtime metadata in a skills-only package", async () => {
    for (const packageRuntime of [
      { dependencies: { effect: "4.0.0-beta.78" } },
      { peerDependencies: { effect: EFFECT_HOST_PEER_RANGE } },
      { optionalDependencies: { effect: "4.0.0-beta.78" } },
      { bundledDependencies: ["effect"] },
      { bundleDependencies: ["effect"] },
    ]) {
      const { root, plugin } = await fixture(null, packageRuntime, {
        includeDistribution: false,
        manifest: skillsOnlyManifest(),
      });
      try {
        await expect(loadProductionPackageForTest(root, plugin, secretStore(), {})).rejects.toThrow(
          "cannot declare runtime metadata without a provider",
        );
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("quarantines legacy provider code before module initialization", async () => {
    const marker = "__f06LegacyAdmission";
    const globals = globalThis as unknown as Record<string, unknown>;
    const secretNames: string[] = [];
    const { root, plugin } = await fixture(
      "4.0.0-beta.78",
      {},
      {
        moduleSource: `globalThis[${JSON.stringify(marker)}] = true;\nexport function createIntegrationProvider() { throw Error("must not execute"); }`,
      },
    );
    try {
      await expect(
        loadProductionPackageForTest(root, plugin, secretStore(secretNames), {}),
      ).rejects.toBeInstanceOf(PluginSdkQuarantineError);
      expect(globals[marker]).toBeUndefined();
      expect(secretNames).toEqual([]);
    } finally {
      delete globals[marker];
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("closes an earlier admitted provider when a later production package fails", async () => {
    let closed = 0;
    const earlier: IntegrationPackage = {
      manifest: validateIntegrationManifest(skillsOnlyManifest()),
      provider: {
        id: "fixture",
        tools: [],
        status: async () => ({
          state: "not_connected",
          accountLabel: null,
          grantedCapabilities: [],
          message: null,
        }),
        invoke: async () => null,
        close: async () => {
          closed++;
        },
      },
    };
    const failure = new Error("later package failed");
    await expect(
      loadProductionPackagesForTest([
        () => Promise.resolve(earlier),
        () => Promise.reject(failure),
      ]),
    ).rejects.toBe(failure);
    expect(closed).toBe(1);
  });

  it("reports only admitted providers and tolerates an unwritable boot receipt", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-boot-report-"));
    const retained = { manifest: validateIntegrationManifest(skillsOnlyManifest()) };
    const reportPath = NodePath.join(root, "boot.json");
    try {
      await expect(
        loadProductionPackagesForTest(
          [() => Promise.reject(new PluginSdkQuarantineError()), () => Promise.resolve(retained)],
          reportPath,
        ),
      ).resolves.toEqual([retained]);
      expect(JSON.parse(await NodeFSP.readFile(reportPath, "utf8"))).toEqual({
        version: 1,
        pid: process.pid,
        pluginIds: [retained.manifest.id],
      });
      await expect(
        loadProductionPackagesForTest([() => Promise.resolve(retained)], root),
      ).resolves.toEqual([retained]);
      await NodeFSP.unlink(reportPath);
      await expect(
        loadProductionPackagesForTest(
          [() => Promise.resolve(retained), () => Promise.reject(new Error("startup failed"))],
          reportPath,
        ),
      ).rejects.toThrow("startup failed");
      await expect(NodeFSP.access(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("quarantines SDK1 packages while retaining a later providerless package", async () => {
    const sdk = composition(await testFiles(sdkGoldenRoot), "synthetic-api-key");
    const data = await fixture(
      null,
      {},
      { includeDistribution: false, manifest: skillsOnlyManifest() },
    );
    try {
      const packages = await loadProductionPackagesForTest([
        () => loadProductionPackageForTest(sdkGoldenRoot, sdk, secretStore(), {}, "24.13.1"),
        () => loadProductionPackageForTest(data.root, data.plugin, secretStore(), {}),
      ]);
      expect(packages.map((item) => item.manifest.id)).toEqual([data.plugin.id]);
      expect(packages[0]?.provider).toBeUndefined();
    } finally {
      await NodeFSP.rm(data.root, { recursive: true, force: true });
    }
  });

  it("loads and installs from a private snapshot of the verified bytes", async () => {
    const { root, plugin } = await fixture();
    let snapshotParent = "";
    try {
      await withProductionPackageSnapshotForTest(root, plugin, async (snapshotRoot) => {
        snapshotParent = NodePath.dirname(snapshotRoot);
        await NodeFSP.writeFile(NodePath.join(root, "dist", "index.js"), "tampered");
        expect(
          await NodeFSP.readFile(NodePath.join(snapshotRoot, "dist", "index.js"), "utf8"),
        ).toContain('from "effect/Effect"');
        await expect(
          import(NodeURL.pathToFileURL(NodePath.join(snapshotRoot, "dist", "index.js")).href),
        ).resolves.toHaveProperty("value");
        expect(
          (
            await NodeFSP.lstat(NodePath.join(snapshotParent, "node_modules", "effect"))
          ).isSymbolicLink(),
        ).toBe(true);
      });
      await expect(NodeFSP.access(snapshotParent)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
      if (snapshotParent) await NodeFSP.rm(snapshotParent, { recursive: true, force: true });
    }
  });

  it("runs the released beta.78 provider with a host-created beta.102 secret-store Effect", async () => {
    const { root, plugin } = await fixture("4.0.0-beta.78");
    try {
      await withProductionPackageSnapshotForTest(root, plugin, async (snapshotRoot) => {
        const loaded = (await import(
          NodeURL.pathToFileURL(NodePath.join(snapshotRoot, "dist", "index.js")).href
        )) as {
          readonly FixtureProvider: new (secrets: {
            readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>>;
          }) => { readonly credential: () => Promise<string | null> };
        };
        const provider = new loaded.FixtureProvider({
          get: () => Effect.succeed(Option.some(new TextEncoder().encode("host-secret"))),
        });
        await expect(provider.credential()).resolves.toBe("host-secret");
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects runtime declarations outside the narrow Effect 4 beta contract", async () => {
    for (const packageRuntime of [
      { dependencies: { effect: "4.0.0-beta.79" } },
      { dependencies: { effect: effectPackageJson.version } },
      { dependencies: { effect: "4.0.0-beta.999" } },
      { dependencies: { effect: "4.0.0-beta.78", unexpected: "1.0.0" } },
      { peerDependencies: { effect: ">=4.0.0-beta.1 <5.0.0" } },
    ]) {
      const { root, plugin } = await fixture(null, packageRuntime);
      try {
        await expect(
          withProductionPackageSnapshotForTest(root, plugin, async () => undefined),
        ).rejects.toThrow("host runtime contract is invalid");
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects package content omitted from the signed inventory", async () => {
    const { root, plugin } = await fixture();
    try {
      await NodeFSP.writeFile(NodePath.join(root, "dist", "unlisted.js"), "unexpected");
      await expect(verifyProductionPackageForTest(root, plugin)).rejects.toThrow(
        "file inventory does not match",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks and invalid inventory paths", async () => {
    const { root, files, plugin } = await fixture();
    try {
      await NodeFSP.rm(NodePath.join(root, "dist", "index.js"));
      await NodeFSP.symlink(
        NodePath.join(root, "package.json"),
        NodePath.join(root, "dist", "index.js"),
      );
      await expect(verifyProductionPackageForTest(root, plugin)).rejects.toThrow("symbolic link");

      const unsafe = composition(files).files.map((file, index) =>
        index === 0 ? { ...file, path: "../plugin.json" } : file,
      );
      await expect(
        verifyProductionPackageForTest(root, { ...plugin, files: unsafe }),
      ).rejects.toThrow("file inventory is invalid");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a valid-looking but incorrect package digest", async () => {
    const { root, plugin } = await fixture();
    try {
      await expect(
        verifyProductionPackageForTest(root, { ...plugin, digest: "0".repeat(64) }),
      ).rejects.toThrow("package digest verification failed");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
