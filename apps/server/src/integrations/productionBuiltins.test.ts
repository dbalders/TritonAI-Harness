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
import {
  loadProductionPackageForTest,
  verifyProductionPackageForTest,
  withProductionPackageSnapshotForTest,
} from "./productionBuiltins.ts";

interface TestFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly contents: Uint8Array;
}

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

async function fixture(
  effectVersion: string | null = effectPackageJson.version,
  packageRuntime: Readonly<Record<string, unknown>> = {},
  options: {
    readonly id?: string;
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
  const entries = [
    [".tritonai-plugin/plugin.json", JSON.stringify(manifest)],
    ["dist/index.js", moduleSource],
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
  ] as const;
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

describe("production built-in package verification", () => {
  it("loads a novel composed provider through the generic factory with scoped inputs", async () => {
    const { root, plugin } = await fixture();
    const secretNames: string[] = [];
    try {
      const loaded = await loadProductionPackageForTest(root, plugin, secretStore(secretNames), {
        endpoint: "https://api.example.test",
      });
      expect(loaded.provider?.id).toBe("future-provider");
      expect(
        (
          loaded.provider as typeof loaded.provider & {
            readonly configuration: unknown;
            readonly credential: () => Promise<string | null>;
          }
        ).configuration,
      ).toEqual({ endpoint: "https://api.example.test" });
      await expect(
        (
          loaded.provider as typeof loaded.provider & {
            readonly credential: () => Promise<string | null>;
          }
        ).credential(),
      ).resolves.toBe("host-secret");
      expect(secretNames).toEqual(["integration-future-provider--oauth"]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, asynchronous, and mismatched provider factories", async () => {
    const cases = [
      {
        source:
          'import manifest from "../.tritonai-plugin/plugin.json" with { type: "json" }; export { manifest };',
        message: "does not export its provider factory",
      },
      {
        source:
          'import manifest from "../.tritonai-plugin/plugin.json" with { type: "json" }; export { manifest }; export async function createIntegrationProvider() { return { id: manifest.provider }; }',
        message: "provider factory must be synchronous",
      },
      {
        source:
          'import manifest from "../.tritonai-plugin/plugin.json" with { type: "json" }; export { manifest }; export function createIntegrationProvider() { return { id: "wrong-provider" }; }',
        message: "provider does not match its composed manifest",
      },
      {
        source:
          'import packageManifest from "../.tritonai-plugin/plugin.json" with { type: "json" }; export const manifest = { ...packageManifest, id: "other-provider" }; export function createIntegrationProvider() { return { id: "future-provider" }; }',
        message: "exports do not match its composed manifest",
      },
    ] as const;
    for (const entry of cases) {
      const { root, plugin } = await fixture(
        effectPackageJson.version,
        {},
        {
          moduleSource: entry.source,
        },
      );
      try {
        await expect(loadProductionPackageForTest(root, plugin, secretStore(), {})).rejects.toThrow(
          entry.message,
        );
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects a provider factory exported by a skills-only package", async () => {
    const manifest = {
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
    const { root, plugin } = await fixture(
      effectPackageJson.version,
      {},
      {
        manifest,
        moduleSource:
          'import manifest from "../.tritonai-plugin/plugin.json" with { type: "json" }; export { manifest }; export function createIntegrationProvider() { return {}; }',
      },
    );
    try {
      await expect(loadProductionPackageForTest(root, plugin, secretStore(), {})).rejects.toThrow(
        "exports a provider factory without declaring a provider",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts an exact package inventory and digest", async () => {
    const { root, plugin } = await fixture();
    try {
      await expect(verifyProductionPackageForTest(root, plugin)).resolves.toBeUndefined();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
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

  it("cleans up a private snapshot when its consumer fails", async () => {
    const { root, plugin } = await fixture();
    let snapshotParent = "";
    try {
      await expect(
        withProductionPackageSnapshotForTest(root, plugin, async (snapshotRoot) => {
          snapshotParent = NodePath.dirname(snapshotRoot);
          throw new Error("fixture consumer failed");
        }),
      ).rejects.toThrow("fixture consumer failed");
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

  it("runs a peer-contract provider against the Harness-owned Effect runtime", async () => {
    const { root, plugin } = await fixture(null, {
      peerDependencies: { effect: EFFECT_HOST_PEER_RANGE },
    });
    try {
      await withProductionPackageSnapshotForTest(root, plugin, async (snapshotRoot) => {
        await expect(
          import(NodeURL.pathToFileURL(NodePath.join(snapshotRoot, "dist", "index.js")).href),
        ).resolves.toHaveProperty("FixtureProvider");
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects runtime declarations outside the narrow Effect 4 beta contract", async () => {
    for (const packageRuntime of [
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
