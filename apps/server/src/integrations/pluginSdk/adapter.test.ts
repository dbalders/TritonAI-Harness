// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { canonicalJson, type JsonValue } from "@t3tools/shared/pluginSdkContract";

import type * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { decodeIntegrationToolInput } from "../IntegrationTool.ts";
import { loadPluginSdkIntegration, PluginSdkQuarantineError } from "./adapter.ts";

const id = "fixture-reader";
const inputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { topic: { type: "string", minLength: 1, maxLength: 32 } },
  required: ["topic"],
  additionalProperties: false,
} as const;
const configurationSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { prefix: { type: "string", maxLength: 16 } },
  required: ["prefix"],
  additionalProperties: false,
} as const;
const manifest = {
  apiVersion: "tritonai.plugin/v1",
  kind: "IntegrationPlugin",
  manifestVersion: 1,
  id,
  name: "Fixture Reader",
  description: "Exercises the generic plugin SDK adapter.",
  version: "1.0.0",
  sdk: { apiMajor: 1, requiredHostContractLevel: 1 },
  entry: "dist/index.mjs",
  provider: id,
  configurationSchema,
  capabilities: [
    {
      id: "fixture.read",
      displayName: "Read fixture",
      description: "Read bounded fixture data.",
      access: "default",
    },
  ],
  tools: [
    {
      name: "fixture.records.list",
      displayName: "List fixture records",
      description: "List bounded fixture records.",
      capabilities: ["fixture.read"],
      effect: "read",
      destructive: false,
      idempotent: true,
      openWorld: false,
      inputSchema,
    },
  ],
  skills: [
    {
      name: "fixture-reader",
      description: "Read deterministic fixture records.",
      capabilities: ["fixture.read"],
    },
  ],
} as const;

const providerSource = `
export function createIntegrationProvider({ secrets, configuration }) {
  return {
    id: "${id}",
    async status({ signal }) {
      signal.throwIfAborted();
      return { state: "connected", accountLabel: configuration.prefix, grantedCapabilities: ["fixture.read"], message: null };
    },
    async invoke(toolName, input, context) {
      context.signal.throwIfAborted();
      if (toolName !== "fixture.records.list") throw new Error("unknown tool");
      return { prefix: configuration.prefix, secret: await secrets.get("token"), topic: input.topic };
    }
  };
}
`;

function sha256(value: string | Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

function artifact(
  entry = providerSource,
  skillBody: string | null = "# Fixture reader\n",
  options: {
    readonly configurationSchema?: JsonValue;
    readonly skillFrontmatter?: string;
    readonly extraPayloads?: ReadonlyArray<readonly [string, Uint8Array]>;
  } = {},
) {
  const artifactConfigurationSchema = options.configurationSchema ?? configurationSchema;
  const artifactManifest = { ...manifest, configurationSchema: artifactConfigurationSchema };
  const manifestBytes = bytes(`${canonicalJson(artifactManifest as unknown as JsonValue)}\n`);
  const payloads = new Map([
    [".tritonai-plugin/plugin.json", manifestBytes],
    ["plugin.mjs", bytes(entry)],
  ]);
  if (skillBody !== null) {
    payloads.set(
      "skills/fixture-reader/SKILL.md",
      bytes(
        `${options.skillFrontmatter ?? "---\nname: fixture-reader\ndescription: Read deterministic fixture records.\n---"}\n\n${skillBody}`,
      ),
    );
  }
  for (const [path, contents] of options.extraPayloads ?? []) payloads.set(path, contents);
  const files = [...payloads.entries()]
    .map(([path, contents]) => ({ path, sha256: sha256(contents), size: contents.byteLength }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const descriptor = {
    artifactVersion: 1,
    format: "tritonai.plugin-artifact/v1",
    plugin: { id, version: "1.0.0" },
    sdk: { apiMajor: 1, requiredHostContractLevel: 1 },
    target: {
      architecture: "any",
      environments: ["electron-main", "server"],
      module: "esm",
      node: ">=24.13.1 <25",
      nodeBuiltins: [],
      platform: "any",
      runtime: "node",
    },
    entry: "plugin.mjs",
    manifest: ".tritonai-plugin/plugin.json",
    configurationSchema: sha256(canonicalJson(artifactConfigurationSchema)),
    schemas: [
      {
        tool: "fixture.records.list",
        sha256: sha256(canonicalJson(inputSchema as unknown as JsonValue)),
      },
    ],
    files,
  };
  return [
    ...payloads.entries().map(([path, contents]) => ({ path, contents })),
    {
      path: "artifact.json",
      contents: bytes(`${canonicalJson(descriptor as unknown as JsonValue)}\n`),
    },
  ];
}

function secretStore(): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: () => Effect.succeed(Option.some(new TextEncoder().encode("scoped-secret"))),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: (_name, size) => Effect.succeed(new Uint8Array(size)),
    remove: () => Effect.void,
  };
}

describe("plugin SDK adapter", () => {
  it("validates schemas before import and adapts exact verified bytes", async () => {
    delete (globalThis as { __pluginSdkImported?: boolean }).__pluginSdkImported;
    const trackedEntry = `globalThis.__pluginSdkImported = true;\n${providerSource}`;
    await expect(
      loadPluginSdkIntegration({
        files: artifact(trackedEntry),
        secrets: secretStore(),
        configuration: { prefix: "ok", extra: true },
        expected: { id, version: "1.0.0" },
        hostNodeVersion: "24.13.1",
      }),
    ).rejects.toThrow();
    expect((globalThis as { __pluginSdkImported?: boolean }).__pluginSdkImported).toBeUndefined();

    const loaded = await loadPluginSdkIntegration({
      files: artifact(),
      secrets: secretStore(),
      configuration: { prefix: "fixture" },
      expected: { id, version: "1.0.0" },
      hostNodeVersion: "24.13.1",
    });
    expect(loaded.manifest.apiVersion).toBe("tritonai.harness/v2");
    expect(loaded.provider?.tools[0]).toMatchObject({
      name: "fixture.records.list",
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
    await expect(
      decodeIntegrationToolInput(loaded.provider!.tools[0]!, { topic: "alpha", extra: true }),
    ).rejects.toThrow();
    await expect(
      loaded.provider?.invoke(
        "fixture.records.list",
        { topic: "alpha" },
        { signal: new AbortController().signal, writeApproved: false },
      ),
    ).resolves.toEqual({ prefix: "fixture", secret: "scoped-secret", topic: "alpha" });
    expect(Object.keys(loaded.bundledFiles ?? {}).sort()).toEqual([
      ".tritonai-plugin/plugin.json",
      "skills/fixture-reader/SKILL.md",
    ]);
    await loaded.provider?.close?.();
  });

  it("fails integrity before import and quarantines provider factory failures", async () => {
    const tampered = artifact().map((file) =>
      file.path === "plugin.mjs"
        ? { ...file, contents: bytes(providerSource.replace("export", "fxport")) }
        : file,
    );
    await expect(
      loadPluginSdkIntegration({
        files: tampered,
        secrets: secretStore(),
        configuration: { prefix: "fixture" },
        expected: { id, version: "1.0.0" },
        hostNodeVersion: "24.13.1",
      }),
    ).rejects.toThrow(/digest mismatch/u);

    await expect(
      loadPluginSdkIntegration({
        files: artifact(
          `export function createIntegrationProvider() { throw new Error("private factory detail"); }\n`,
        ),
        secrets: secretStore(),
        configuration: { prefix: "fixture" },
        expected: { id, version: "1.0.0" },
        hostNodeVersion: "24.13.1",
      }),
    ).rejects.toBeInstanceOf(PluginSdkQuarantineError);

    for (const entry of [
      `export function createIntegrationProvider() {
        return Object.defineProperty({ async status() {}, async invoke() {} }, "id", {
          get() { throw new Error("private getter detail"); }
        });
      }\n`,
      `export function createIntegrationProvider() {
        return { id: "${id}", async status() {}, async invoke() {}, close: true };
      }\n`,
    ]) {
      await expect(
        loadPluginSdkIntegration({
          files: artifact(entry),
          secrets: secretStore(),
          configuration: { prefix: "fixture" },
          expected: { id, version: "1.0.0" },
          hostNodeVersion: "24.13.1",
        }),
      ).rejects.toBeInstanceOf(PluginSdkQuarantineError);
    }
  });

  it("requires the manifest's exact skill inventory and frontmatter", async () => {
    const load = (files: ReturnType<typeof artifact>) =>
      loadPluginSdkIntegration({
        files,
        secrets: secretStore(),
        configuration: { prefix: "fixture" },
        expected: { id, version: "1.0.0" },
        hostNodeVersion: "24.13.1",
      });
    await expect(load(artifact(providerSource, null))).rejects.toThrow(/payload inventory/u);
    await expect(
      load(
        artifact(providerSource, "# Fixture reader\n", {
          extraPayloads: [["skills/undeclared/SKILL.md", bytes("undeclared\n")]],
        }),
      ),
    ).rejects.toThrow(/payload inventory/u);
    await expect(
      load(
        artifact(providerSource, "# Fixture reader\n", {
          skillFrontmatter:
            "---\nname: fixture-reader\ndescription: Drifted fixture description.\n---",
        }),
      ),
    ).rejects.toThrow(/frontmatter does not match/u);
  });

  it("inspects only schema positions and preserves JSON Pointer tokens", async () => {
    const load = (schema: JsonValue) =>
      loadPluginSdkIntegration({
        files: artifact(providerSource, "# Fixture reader\n", { configurationSchema: schema }),
        secrets: secretStore(),
        configuration: { pattern: "fixture" },
        expected: { id, version: "1.0.0" },
        hostNodeVersion: "24.13.1",
      });
    await expect(
      load({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        $defs: { label: { type: "string" } },
        properties: {
          pattern: { $ref: "#/%24defs/label" },
          metadata: { type: "object", default: { $id: "instance-data", $ref: "not-a-schema" } },
        },
      }),
    ).resolves.toBeDefined();
    await expect(
      load({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        $defs: { item: { type: "object" } },
        properties: { pattern: { $ref: "#/$defs/item/" } },
      }),
    ).rejects.toThrow(/does not resolve/u);
  });

  it("isolates module state by the complete admitted artifact", async () => {
    const statefulSource = `
let instanceCount = 0;
export function createIntegrationProvider() {
  const accountLabel = String(++instanceCount);
  return {
    id: "${id}",
    async status() { return { state: "connected", accountLabel, grantedCapabilities: ["fixture.read"], message: null }; },
    async invoke() { return null; }
  };
}
`;
    const load = (skillBody: string) =>
      loadPluginSdkIntegration({
        files: artifact(statefulSource, skillBody),
        secrets: secretStore(),
        configuration: { prefix: "fixture" },
        expected: { id, version: "1.0.0" },
        hostNodeVersion: "24.13.1",
      });
    const first = await load("# First reviewed artifact\n");
    const second = await load("# Second reviewed artifact\n");
    const context = { signal: new AbortController().signal };

    await expect(first.provider?.status(context)).resolves.toMatchObject({ accountLabel: "1" });
    await expect(second.provider?.status(context)).resolves.toMatchObject({ accountLabel: "1" });
  });
});
