// @effect-diagnostics nodeBuiltinImport:off -- Artifact identities use the same SHA-256 bytes as sealed packages.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";
import { canonicalJson, type JsonObject, type JsonValue } from "@t3tools/shared/pluginSdkContract";
import {
  verifyIsolatedPluginSdkArtifact,
  verifyPluginSdkArtifact,
} from "@t3tools/shared/pluginSdkArtifact";

const manifestPath = ".tritonai-plugin/plugin.json";
const policyPath = ".tritonai-plugin/broker-policy.json";
const sha = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const bytes = (value: JsonValue) => Buffer.from(`${canonicalJson(value)}\n`);
const emptySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const source = `throw new Error("Verification must not evaluate plugin code");
export function createIntegrationProvider({ broker }) {
  return { invoke: (tool, input) => broker.request(tool + ".v1", input) };
}`;

function artifact(
  options: {
    readonly manifest?: JsonObject;
    readonly policy?: JsonObject;
    readonly descriptor?: JsonObject;
    readonly source?: string;
    readonly extra?: ReadonlyArray<{ readonly path: string; readonly contents: Uint8Array }>;
  } = {},
) {
  const tool = {
    name: "fixture.records.list",
    displayName: "List records",
    description: "Read synthetic records.",
    capabilities: ["fixture.read"],
    effect: "read",
    destructive: false,
    idempotent: true,
    openWorld: false,
    inputSchema: emptySchema,
  };
  const manifest = {
    apiVersion: "tritonai.plugin/v2",
    kind: "IntegrationPlugin",
    manifestVersion: 2,
    id: "fixture-broker",
    name: "Fixture broker",
    description: "Synthetic isolated artifact.",
    version: "2.0.0",
    sdk: { apiMajor: 2, requiredHostContractLevel: 3 },
    entry: "dist/index.mjs",
    provider: "fixture-broker",
    configurationSchema: emptySchema,
    capabilities: [
      {
        id: "fixture.read",
        displayName: "Read",
        description: "Read synthetic data.",
        access: "default",
      },
    ],
    tools: [tool],
    skills: [],
    broker: {
      protocol: "tritonai.plugin-broker/v1",
      policyId: "fixture-broker.v1",
      policyVersion: 1,
      operations: [{ id: "fixture.records.list.v1", tool: tool.name }],
    },
    ...options.manifest,
  };
  const policy = {
    format: "tritonai.plugin-broker-policy/v1",
    id: "fixture-broker.v1",
    pluginId: "fixture-broker",
    version: 1,
    credential: {
      recipe: "host-api-key/v1",
      capabilities: ["fixture.read"],
      requiredCapabilities: [],
    },
    transport: { kind: "synthetic" },
    operations: [
      {
        id: "fixture.records.list.v1",
        tool: tool.name,
        effect: "read",
        capabilities: ["fixture.read"],
        recipe: { kind: "synthetic-items-list" },
      },
    ],
    ...options.policy,
  };
  const files = [
    { path: manifestPath, contents: bytes(manifest) },
    { path: policyPath, contents: bytes(policy) },
    { path: "plugin.mjs", contents: Buffer.from(options.source ?? source) },
    ...(options.extra ?? []),
  ];
  const descriptor = {
    artifactVersion: 2,
    format: "tritonai.plugin-artifact/v2",
    plugin: { id: manifest.id, version: manifest.version },
    sdk: manifest.sdk,
    target: {
      architecture: "any",
      environments: ["isolated-worker"],
      module: "esm",
      node: ">=24.13.1 <25",
      platform: "any",
      runtime: "node",
      nodeBuiltins: [],
    },
    entry: "plugin.mjs",
    manifest: manifestPath,
    configurationSchema: sha(canonicalJson(manifest.configurationSchema)),
    schemas: [{ tool: tool.name, sha256: sha(canonicalJson(tool.inputSchema)) }],
    files: files
      .map(({ path, contents }) => ({ path, sha256: sha(contents), size: contents.byteLength }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    broker: {
      protocol: "tritonai.plugin-broker/v1",
      policy: { path: policyPath, sha256: sha(bytes(policy)), id: "fixture-broker.v1", version: 1 },
    },
    ...options.descriptor,
  };
  return [...files, { path: "artifact.json", contents: bytes(descriptor) }];
}

const runtime = { workerNodeVersion: "24.22.1" };

it("verifies the complete isolated artifact without evaluating its entry or granting policy authority", () => {
  const files = artifact();
  const checked = verifyIsolatedPluginSdkArtifact(files, runtime);
  expect(checked.sdkManifest.sdk.apiMajor).toBe(2);
  expect(checked.descriptor.target.environments).toEqual(["isolated-worker"]);
  expect(Buffer.from(checked.entryBytes).toString()).toBe(source);
  expect(checked.policyFileSha256).toBe(sha(checked.policyBytes));
  expect(checked.policyFileSha256).not.toBe(
    sha(Buffer.from(checked.policyBytes).toString().trimEnd()),
  );
  expect(checked.manifest.tools[0]?.name).toBe("fixture.records.list");
  expect(() => verifyPluginSdkArtifact(files, { hostNodeVersion: "24.22.1" })).toThrow();
  files.find(({ path }) => path === "plugin.mjs")!.contents.fill(0);
  expect(Buffer.from(checked.entryBytes).toString()).toBe(source);
});

it("retains verified skill entrypoints under their exact artifact paths", () => {
  const path = "skills/fixture-broker/SKILL.md";
  const contents = Buffer.from(
    "---\nname: fixture-broker\ndescription: Read deterministic fixture records.\n---\n\n# Fixture\n",
  );
  const checked = verifyIsolatedPluginSdkArtifact(
    artifact({
      manifest: {
        skills: [
          {
            name: "fixture-broker",
            description: "Read deterministic fixture records.",
            capabilities: ["fixture.read"],
          },
        ],
      },
      extra: [{ path, contents }],
    }),
    runtime,
  );
  expect(Buffer.from(checked.skillFiles[path]!)).toEqual(contents);
});

it.each([undefined, null, "24.13.0", "26.12.1", "24.22.1-extra"])(
  "requires the actual supported worker version rather than a host compatibility override (%s)",
  (workerNodeVersion) => {
    expect(() =>
      verifyIsolatedPluginSdkArtifact(artifact(), { workerNodeVersion } as never),
    ).toThrow();
  },
);

it.each([manifestPath, policyPath, "plugin.mjs", "artifact.json"])(
  "rejects altered sealed bytes at %s",
  (path) => {
    const changed = artifact().map((file) =>
      file.path === path
        ? { ...file, contents: Buffer.concat([Buffer.from(file.contents), Buffer.from(" ")]) }
        : file,
    );
    expect(() => verifyIsolatedPluginSdkArtifact(changed, runtime)).toThrow();
  },
);

it.each([
  { manifest: { sdk: { apiMajor: 1, requiredHostContractLevel: 2 } } },
  { manifest: { manifestVersion: 1 } },
  {
    manifest: {
      broker: {
        protocol: "tritonai.plugin-broker/v1",
        policyId: "fixture-broker.v1",
        policyVersion: 1,
        operations: [{ id: "another.operation.v1", tool: "fixture.records.list" }],
      },
    },
  },
  { policy: { id: "another-policy" } },
  { policy: { pluginId: "another-plugin" } },
  {
    policy: {
      operations: [
        {
          id: "fixture.records.list.v1",
          tool: "fixture.records.list",
          effect: "write",
          capabilities: ["fixture.read"],
        },
      ],
    },
  },
  { descriptor: { artifactVersion: 1, format: "tritonai.plugin-artifact/v1" } },
  { descriptor: { target: { environments: ["server"] } } },
])("rejects mismatched identity, policy bindings and execution ABI (%j)", (options) => {
  expect(() => verifyIsolatedPluginSdkArtifact(artifact(options), runtime)).toThrow();
});

it.each(["secret.txt", "skills/CON/SKILL.md", "skills/extra./SKILL.md", "file:stream"])(
  "rejects undeclared or nonportable artifact paths (%s)",
  (path) => {
    expect(() =>
      verifyIsolatedPluginSdkArtifact(
        artifact({ extra: [{ path, contents: Buffer.from("synthetic") }] }),
        runtime,
      ),
    ).toThrow();
  },
);

it("rejects duplicate files, runtime imports and oversize entries before execution", () => {
  const files = artifact();
  expect(() => verifyIsolatedPluginSdkArtifact([...files, files[0]!], runtime)).toThrow();
  expect(() =>
    verifyIsolatedPluginSdkArtifact(
      artifact({ source: `import fs from 'node:fs';\n${source}` }),
      runtime,
    ),
  ).toThrow();
  expect(() =>
    verifyIsolatedPluginSdkArtifact(artifact({ source: " ".repeat(524_289) }), runtime),
  ).toThrow(/byte limit/);
});
