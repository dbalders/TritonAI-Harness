// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { initSync, parse } from "es-module-lexer";

import {
  canonicalJson,
  isRecord,
  type JsonValue,
  PLUGIN_SDK_API_MAJOR,
  PLUGIN_SDK_HOST_CONTRACT_LEVEL,
  type PluginSdkManifest,
  validatePluginSdkManifest,
} from "./pluginSdkContract.ts";

const ARTIFACT_PATH = "artifact.json";
const MANIFEST_PATH = ".tritonai-plugin/plugin.json";
const ENTRY_PATH = "plugin.mjs";
const SHA256 = /^[a-f0-9]{64}$/u;
const DESCRIPTOR_KEYS = new Set([
  "artifactVersion",
  "format",
  "plugin",
  "sdk",
  "target",
  "entry",
  "manifest",
  "configurationSchema",
  "schemas",
  "files",
]);
const TARGET = {
  architecture: "any",
  environments: ["electron-main", "server"],
  module: "esm",
  node: ">=24.13.1 <25",
  platform: "any",
  runtime: "node",
} as const;

export interface PluginSdkArtifactFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

interface ArtifactFileRecord {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface PluginSdkArtifactDescriptor {
  readonly artifactVersion: 1;
  readonly format: "tritonai.plugin-artifact/v1";
  readonly plugin: { readonly id: string; readonly version: string };
  readonly sdk: { readonly apiMajor: 1; readonly requiredHostContractLevel: number };
  readonly target: typeof TARGET & { readonly nodeBuiltins: ReadonlyArray<string> };
  readonly entry: typeof ENTRY_PATH;
  readonly manifest: typeof MANIFEST_PATH;
  readonly configurationSchema: string;
  readonly schemas: ReadonlyArray<{ readonly tool: string; readonly sha256: string }>;
  readonly files: ReadonlyArray<ArtifactFileRecord>;
}

export interface VerifiedPluginSdkArtifact {
  readonly descriptor: PluginSdkArtifactDescriptor;
  readonly descriptorSha256: string;
  readonly sdkManifest: PluginSdkManifest;
  readonly manifest: ReturnType<typeof validatePluginSdkManifest>["manifest"];
  readonly entryBytes: Uint8Array;
  readonly skillFiles: Readonly<Record<string, Uint8Array>>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function onlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function sha256(contents: Uint8Array | string): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

function canonicalBytes(value: JsonValue): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function parseCanonicalJson(bytes: Uint8Array, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  assert(
    Buffer.from(bytes).equals(Buffer.from(canonicalBytes(value as JsonValue))),
    `${label} must use canonical JSON with one trailing newline.`,
  );
  return value;
}

function assertSafePaths(paths: ReadonlyArray<string>): void {
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const path of paths) {
    assert(
      path.length > 0 &&
        path.length <= 512 &&
        path === path.normalize("NFC") &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        !path.startsWith("/") &&
        path.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
      `Plugin SDK artifact path is invalid: ${path}.`,
    );
    assert(!exact.has(path), `Plugin SDK artifact path is duplicated: ${path}.`);
    assert(
      !folded.has(path.toLowerCase()),
      `Plugin SDK artifact path has a case collision: ${path}.`,
    );
    exact.add(path);
    folded.add(path.toLowerCase());
  }
}

function nodeVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return major === 24 && (minor > 13 || (minor === 13 && patch >= 1));
}

function inspectModule(source: string): {
  readonly nodeBuiltins: ReadonlyArray<string>;
  readonly exports: ReadonlyArray<string>;
} {
  initSync();
  const [imports, exports] = parse(source);
  const nodeBuiltins: string[] = [];
  for (const request of imports) {
    assert(request.d !== -2, "Plugin SDK entry cannot use import.meta.");
    assert(request.n !== undefined, "Plugin SDK entry cannot compute an import specifier.");
    assert(request.d === -1, "Plugin SDK entry cannot import modules dynamically.");
    assert(
      request.n.startsWith("node:"),
      `Plugin SDK entry has an unresolved dependency: ${request.n}.`,
    );
    nodeBuiltins.push(request.n);
  }
  return {
    nodeBuiltins: [...new Set(nodeBuiltins)].sort(),
    exports: exports.map(({ n }) => n).sort(),
  };
}

export function hasPluginSdkArtifact(files: ReadonlyArray<{ readonly path: string }>): boolean {
  return files.some(({ path }) => path === ARTIFACT_PATH);
}

export function verifyPluginSdkArtifact(
  files: ReadonlyArray<PluginSdkArtifactFile>,
  options: { readonly hostNodeVersion?: string | null } = {},
): VerifiedPluginSdkArtifact {
  const paths = files.map(({ path }) => path);
  assertSafePaths(paths);
  assert(new Set(paths).size === paths.length, "Plugin SDK artifact file inventory is duplicated.");
  const payloads = new Map(files.map(({ path, contents }) => [path, Uint8Array.from(contents)]));
  const descriptorBytes = payloads.get(ARTIFACT_PATH);
  assert(descriptorBytes, "Plugin SDK artifact descriptor is missing.");
  const descriptorValue = parseCanonicalJson(descriptorBytes, "Plugin SDK artifact descriptor");
  assert(
    isRecord(descriptorValue) && onlyKeys(descriptorValue, DESCRIPTOR_KEYS),
    "Plugin SDK artifact descriptor shape is invalid.",
  );
  const descriptor = descriptorValue as unknown as PluginSdkArtifactDescriptor;
  assert(
    descriptor.format === "tritonai.plugin-artifact/v1" && descriptor.artifactVersion === 1,
    "Plugin SDK artifact format is unsupported.",
  );
  assert(
    isRecord(descriptor.sdk) &&
      onlyKeys(descriptor.sdk, new Set(["apiMajor", "requiredHostContractLevel"])) &&
      descriptor.sdk.apiMajor === PLUGIN_SDK_API_MAJOR &&
      Number.isSafeInteger(descriptor.sdk.requiredHostContractLevel) &&
      descriptor.sdk.requiredHostContractLevel > 0 &&
      descriptor.sdk.requiredHostContractLevel <= PLUGIN_SDK_HOST_CONTRACT_LEVEL,
    "Plugin SDK artifact requires an unsupported host contract.",
  );
  const target = descriptor.target;
  assert(
    isRecord(target) &&
      canonicalJson({
        architecture: target.architecture,
        environments: target.environments,
        module: target.module,
        node: target.node,
        platform: target.platform,
        runtime: target.runtime,
      }) === canonicalJson(TARGET) &&
      Array.isArray(target.nodeBuiltins) &&
      target.nodeBuiltins.every(
        (specifier) => typeof specifier === "string" && specifier.startsWith("node:"),
      ) &&
      target.nodeBuiltins.every(
        (specifier, index) => index === 0 || target.nodeBuiltins[index - 1]! < specifier,
      ),
    "Plugin SDK artifact runtime target is unsupported.",
  );
  const hostNodeVersion =
    options.hostNodeVersion === undefined ? process.versions.node : options.hostNodeVersion;
  assert(
    hostNodeVersion === null || nodeVersionSupported(hostNodeVersion),
    "Plugin SDK artifact requires Node 24.13.1 or newer within Node 24.",
  );
  assert(
    descriptor.entry === ENTRY_PATH && descriptor.manifest === MANIFEST_PATH,
    "Plugin SDK artifact paths are unsupported.",
  );
  assert(
    Array.isArray(descriptor.files) && descriptor.files.length > 0,
    "Plugin SDK artifact files are missing.",
  );
  const descriptorFiles = descriptor.files.map((file, index): ArtifactFileRecord => {
    assert(
      isRecord(file) && onlyKeys(file, new Set(["path", "sha256", "size"])),
      `Plugin SDK artifact file record is invalid at index ${index}.`,
    );
    assert(
      typeof file.path === "string",
      `Plugin SDK artifact file path is invalid at index ${index}.`,
    );
    assert(
      typeof file.sha256 === "string" && SHA256.test(file.sha256),
      `Plugin SDK artifact file digest is invalid: ${file.path}.`,
    );
    assert(
      typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0,
      `Plugin SDK artifact file size is invalid: ${file.path}.`,
    );
    return { path: file.path, sha256: file.sha256, size: file.size };
  });
  const listedPaths = descriptorFiles.map(({ path }) => path);
  assertSafePaths(listedPaths);
  assert(
    listedPaths.every((path, index) => index === 0 || listedPaths[index - 1]! < path),
    "Plugin SDK artifact files must be sorted.",
  );
  assert(
    paths.length === listedPaths.length + 1 &&
      paths.every((path) => path === ARTIFACT_PATH || listedPaths.includes(path)),
    "Plugin SDK artifact file inventory is incomplete.",
  );
  for (const file of descriptorFiles) {
    const contents = payloads.get(file.path);
    assert(contents, `Plugin SDK artifact payload is missing: ${file.path}.`);
    assert(
      Number.isSafeInteger(file.size) && file.size >= 0 && contents.byteLength === file.size,
      `Plugin SDK artifact size mismatch: ${file.path}.`,
    );
    assert(sha256(contents) === file.sha256, `Plugin SDK artifact digest mismatch: ${file.path}.`);
  }

  const manifestBytes = payloads.get(MANIFEST_PATH);
  const entryBytes = payloads.get(ENTRY_PATH);
  assert(manifestBytes && entryBytes, "Plugin SDK artifact manifest or entry is missing.");
  const { sdkManifest, manifest } = validatePluginSdkManifest(
    parseCanonicalJson(manifestBytes, "Plugin SDK manifest"),
  );
  const source = Buffer.from(entryBytes).toString("utf8");
  assert(
    Buffer.from(source, "utf8").equals(Buffer.from(entryBytes)),
    "Plugin SDK entry must be UTF-8.",
  );
  const module = inspectModule(source);
  assert(
    canonicalJson(module.exports) === canonicalJson(["createIntegrationProvider"]),
    "Plugin SDK entry must export only createIntegrationProvider.",
  );
  const expectedFiles = [...payloads.entries()]
    .filter(([path]) => path !== ARTIFACT_PATH)
    .map(([path, contents]) => ({ path, sha256: sha256(contents), size: contents.byteLength }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const expectedDescriptor: PluginSdkArtifactDescriptor = {
    artifactVersion: 1,
    format: "tritonai.plugin-artifact/v1",
    plugin: { id: sdkManifest.id, version: sdkManifest.version },
    sdk: sdkManifest.sdk,
    target: { ...TARGET, nodeBuiltins: module.nodeBuiltins },
    entry: ENTRY_PATH,
    manifest: MANIFEST_PATH,
    configurationSchema: sha256(canonicalJson(sdkManifest.configurationSchema)),
    schemas: sdkManifest.tools
      .map(({ name, inputSchema }) => ({ tool: name, sha256: sha256(canonicalJson(inputSchema)) }))
      .sort((left, right) => (left.tool < right.tool ? -1 : left.tool > right.tool ? 1 : 0)),
    files: expectedFiles,
  };
  assert(
    canonicalJson(descriptor as unknown as JsonValue) ===
      canonicalJson(expectedDescriptor as unknown as JsonValue),
    "Plugin SDK artifact descriptor does not match its exact payloads.",
  );
  const skillFiles = Object.fromEntries(
    [...payloads.entries()]
      .filter(([path]) => path.startsWith("skills/"))
      .map(([path, contents]) => [path, Uint8Array.from(contents)]),
  );
  return {
    descriptor,
    descriptorSha256: sha256(descriptorBytes),
    sdkManifest,
    manifest,
    entryBytes,
    skillFiles,
  };
}
