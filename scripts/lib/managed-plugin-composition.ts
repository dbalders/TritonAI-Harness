// @effect-diagnostics nodeBuiltinImport:off - Release composition is verified before an Effect runtime exists.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { validateIntegrationManifest } from "@t3tools/contracts";

export const MANAGED_PLUGIN_COMPOSITION_FILE = "tritonai-plugin-composition.json";
export const MANAGED_PLUGIN_COMPOSITION_KIND = "tritonai-harness-plugin-composition";
export const MANAGED_PLUGIN_COMPOSITION_VERSION = 1;
export const PRODUCTION_PLUGIN_SOURCE_ENV = "TRITONAI_PLUGIN_COMPOSITION_SOURCE";

const CANONICAL_PLUGIN_REPOSITORY = "https://github.com/dbalders/TritonAI-Plugins.git";
const SUPPORTED_PRODUCTION_PLUGIN_IDS = new Set(["microsoft-365"]);
const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/u;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const MAX_PLUGIN_FILES = 512;
const MAX_PLUGIN_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PLUGIN_PACKAGE_BYTES = 64 * 1024 * 1024;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ManagedPluginFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ManagedPluginPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly files: ReadonlyArray<ManagedPluginFile>;
}

export interface ManagedPluginComposition {
  readonly version: 1;
  readonly kind: typeof MANAGED_PLUGIN_COMPOSITION_KIND;
  readonly source: {
    readonly repository: typeof CANONICAL_PLUGIN_REPOSITORY;
    readonly ref: string;
    readonly commit: string;
  };
  readonly packages: ReadonlyArray<ManagedPluginPackage>;
}

export interface ManagedPluginArtifact {
  readonly fileName: string;
  readonly sha512: string;
  readonly size: number;
}

export interface ArtifactBoundManagedPluginComposition extends ManagedPluginComposition {
  readonly artifacts: ReadonlyArray<ManagedPluginArtifact>;
}

export function managedPluginProofFileName(platform: "mac" | "win", arch: string): string {
  if (!/^(?:arm64|x64|universal)$/u.test(arch)) {
    throw new Error(`Managed plugin proof architecture is unsupported: ${arch}.`);
  }
  return `tritonai-plugin-composition-${platform}-${arch}.json`;
}

export function managedPluginProofInputFileName(platform: "mac" | "win", arch: string): string {
  return `.${managedPluginProofFileName(platform, arch)}.input`;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlyArray<string>,
  label: string,
): void {
  const supported = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !supported.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}.`);
  }
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || !/^[\x20-\x7e]+$/u.test(value)) return false;
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("//")
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function sha256(contents: NodeJS.ArrayBufferView): string {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

function assertRealDirectory(path: string, label: string): void {
  const stat = NodeFS.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

function assertRegularFile(path: string, label: string): void {
  const stat = NodeFS.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
}

function digestFileSet(packageRoot: string, files: ReadonlyArray<ManagedPluginFile>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(String(file.size), "utf8");
    hash.update("\0");
    hash.update(NodeFS.readFileSync(NodePath.join(packageRoot, file.path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function describeFiles(root: string): ReadonlyArray<ManagedPluginFile> {
  const result: Array<ManagedPluginFile> = [];
  const walk = (relative: string): void => {
    for (const entry of NodeFS.readdirSync(NodePath.join(root, relative), {
      withFileTypes: true,
    })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = NodePath.join(root, childRelative);
      const stat = NodeFS.lstatSync(child);
      if (stat.isSymbolicLink()) {
        throw new Error(`Managed plugin package cannot contain symbolic links: ${childRelative}.`);
      }
      if (stat.isDirectory()) walk(childRelative);
      else if (stat.isFile()) {
        if (stat.size > MAX_PLUGIN_FILE_BYTES) {
          throw new Error(
            `Managed plugin file exceeds the ${MAX_PLUGIN_FILE_BYTES}-byte limit: ${childRelative}.`,
          );
        }
        const contents = NodeFS.readFileSync(child);
        result.push({ path: childRelative, sha256: sha256(contents), size: stat.size });
      } else {
        throw new Error(`Managed plugin package contains a special file: ${childRelative}.`);
      }
    }
  };
  walk("");
  return result.toSorted((left, right) => compareText(left.path, right.path));
}

function validatePackage(
  sourceRoot: string,
  value: unknown,
  previousId: string,
): ManagedPluginPackage {
  assertRecord(value, "Managed plugin package");
  assertOnlyKeys(value, ["id", "name", "version", "digest", "files"], "Managed plugin package");
  const { id, name, version, digest, files } = value;
  if (typeof id !== "string" || !SUPPORTED_PRODUCTION_PLUGIN_IDS.has(id)) {
    throw new Error(`Managed plugin package is not build-allowlisted: ${String(id)}.`);
  }
  if (id <= previousId) throw new Error("Managed plugin packages must be unique and sorted by id.");
  if (
    name !== `@tritonai/plugin-${id}` ||
    typeof version !== "string" ||
    !STABLE_SEMVER.test(version)
  ) {
    throw new Error(`Managed plugin ${id} has invalid package metadata.`);
  }
  if (typeof digest !== "string" || !SHA256.test(digest)) {
    throw new Error(`Managed plugin ${id} has an invalid package digest.`);
  }
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_PLUGIN_FILES) {
    throw new Error(`Managed plugin ${id} has an invalid file count.`);
  }
  let previousPath = "";
  let totalBytes = 0;
  const normalizedFiles = files.map((file): ManagedPluginFile => {
    assertRecord(file, `Managed plugin ${id} file`);
    assertOnlyKeys(file, ["path", "sha256", "size"], `Managed plugin ${id} file`);
    if (!isSafeRelativePath(file.path) || file.path <= previousPath) {
      throw new Error(`Managed plugin ${id} file paths must be safe, unique, and sorted.`);
    }
    previousPath = file.path;
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      throw new Error(`Managed plugin ${id} file ${file.path} has an invalid digest.`);
    }
    if (
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      (file.size as number) > MAX_PLUGIN_FILE_BYTES
    ) {
      throw new Error(`Managed plugin ${id} file ${file.path} has an invalid size.`);
    }
    totalBytes += file.size as number;
    return { path: file.path, sha256: file.sha256, size: file.size as number };
  });
  if (totalBytes > MAX_PLUGIN_PACKAGE_BYTES) {
    throw new Error(
      `Managed plugin ${id} exceeds the ${MAX_PLUGIN_PACKAGE_BYTES}-byte package limit.`,
    );
  }

  const packageRoot = NodePath.join(sourceRoot, "packages", id);
  assertRealDirectory(packageRoot, `Managed plugin ${id} package root`);
  const actualFiles = describeFiles(packageRoot);
  if (!NodeUtil.isDeepStrictEqual(actualFiles, normalizedFiles)) {
    throw new Error(`Managed plugin ${id} files do not match their composition proof.`);
  }
  if (digestFileSet(packageRoot, actualFiles) !== digest) {
    throw new Error(`Managed plugin ${id} package digest does not match its composition proof.`);
  }

  const packageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8"),
  ) as unknown;
  assertRecord(packageJson, `Managed plugin ${id} package.json`);
  if (packageJson.name !== name || packageJson.version !== version) {
    throw new Error(`Managed plugin ${id} package.json does not match its composition proof.`);
  }
  const manifest = validateIntegrationManifest(
    JSON.parse(
      NodeFS.readFileSync(NodePath.join(packageRoot, ".tritonai-plugin", "plugin.json"), "utf8"),
    ),
  );
  if (manifest.id !== id || manifest.version !== version) {
    throw new Error(`Managed plugin ${id} manifest does not match its composition proof.`);
  }
  return { id, name, version, digest, files: normalizedFiles };
}

export function readManagedPluginComposition(sourceRoot: string): ManagedPluginComposition {
  const absoluteRoot = NodePath.resolve(sourceRoot);
  const rootStat = NodeFS.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Managed plugin composition source must be a real directory.");
  }
  const rootEntries = NodeFS.readdirSync(absoluteRoot).toSorted();
  if (!NodeUtil.isDeepStrictEqual(rootEntries, ["manifest.json", "packages"])) {
    throw new Error("Managed plugin composition source contains unsupported root entries.");
  }
  const manifestPath = NodePath.join(absoluteRoot, "manifest.json");
  const packagesRoot = NodePath.join(absoluteRoot, "packages");
  assertRegularFile(manifestPath, "Managed plugin composition manifest");
  assertRealDirectory(packagesRoot, "Managed plugin composition packages root");
  const value = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as unknown;
  assertRecord(value, "Managed plugin composition");
  assertOnlyKeys(value, ["version", "kind", "source", "packages"], "Managed plugin composition");
  if (
    value.version !== MANAGED_PLUGIN_COMPOSITION_VERSION ||
    value.kind !== MANAGED_PLUGIN_COMPOSITION_KIND
  ) {
    throw new Error("Managed plugin composition has an unsupported version or kind.");
  }
  assertRecord(value.source, "Managed plugin composition source");
  assertOnlyKeys(
    value.source,
    ["repository", "ref", "commit"],
    "Managed plugin composition source",
  );
  if (value.source.repository !== CANONICAL_PLUGIN_REPOSITORY) {
    throw new Error(
      "Managed plugin composition must come from the canonical TritonAI-Plugins repository.",
    );
  }
  if (
    typeof value.source.ref !== "string" ||
    !SAFE_REF.test(value.source.ref) ||
    value.source.ref.includes("..") ||
    value.source.ref.includes("@{") ||
    value.source.ref.includes("//") ||
    typeof value.source.commit !== "string" ||
    !COMMIT.test(value.source.commit)
  ) {
    throw new Error("Managed plugin composition must pin a safe Git ref and full commit SHA.");
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0) {
    throw new Error("Managed plugin composition must select at least one production package.");
  }
  let previousId = "";
  const packages = value.packages.map((plugin) => {
    const normalized = validatePackage(absoluteRoot, plugin, previousId);
    previousId = normalized.id;
    return normalized;
  });
  const packageEntries = NodeFS.readdirSync(packagesRoot).toSorted();
  const expectedPackageEntries = packages.map(({ id }) => id);
  if (!NodeUtil.isDeepStrictEqual(packageEntries, expectedPackageEntries)) {
    throw new Error("Managed plugin composition packages contain unlisted entries.");
  }
  return {
    version: MANAGED_PLUGIN_COMPOSITION_VERSION,
    kind: MANAGED_PLUGIN_COMPOSITION_KIND,
    source: {
      repository: CANONICAL_PLUGIN_REPOSITORY,
      ref: value.source.ref,
      commit: value.source.commit,
    },
    packages,
  };
}

export function snapshotManagedPluginComposition(
  sourceRoot: string,
  targetRoot: string,
): ManagedPluginComposition {
  const expected = readManagedPluginComposition(sourceRoot);
  NodeFS.rmSync(targetRoot, { recursive: true, force: true });
  NodeFS.cpSync(NodePath.resolve(sourceRoot), targetRoot, { recursive: true, errorOnExist: true });
  const copied = readManagedPluginComposition(targetRoot);
  if (!NodeUtil.isDeepStrictEqual(copied, expected)) {
    throw new Error("Managed plugin composition changed while it was being snapshotted.");
  }
  return copied;
}

export function loadManagedPluginCompositionFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly root: string; readonly composition: ManagedPluginComposition } | null {
  const configured = env[PRODUCTION_PLUGIN_SOURCE_ENV]?.trim();
  if (!configured) return null;
  const root = NodePath.resolve(configured);
  return { root, composition: readManagedPluginComposition(root) };
}

export function assertManagedPluginBuildConfiguration(
  composition: ManagedPluginComposition,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (!composition.packages.some(({ id }) => id === "microsoft-365")) return;
  const entraIdentifier =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  for (const name of [
    "TRITONAI_MICROSOFT_GRAPH_CLIENT_ID",
    "TRITONAI_MICROSOFT_GRAPH_TENANT_ID",
  ] as const) {
    if (!entraIdentifier.test(env[name]?.trim() ?? "")) {
      throw new Error(
        `${name} must be a valid Entra identifier for a Microsoft 365 production composition.`,
      );
    }
  }
}

async function sha512Base64(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha512");
  await new Promise<void>((resolve, reject) => {
    const input = NodeFS.createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("base64");
}

export async function bindManagedPluginCompositionToArtifacts(
  composition: ManagedPluginComposition,
  artifactPaths: ReadonlyArray<string>,
): Promise<ArtifactBoundManagedPluginComposition> {
  if (artifactPaths.length === 0) {
    throw new Error(
      "Managed plugin composition cannot be emitted without a final DMG or EXE artifact.",
    );
  }
  const artifacts = await Promise.all(
    artifactPaths.map(async (artifactPath): Promise<ManagedPluginArtifact> => {
      const fileName = NodePath.basename(artifactPath);
      if (!/^TritonAI-Harness-.+\.(?:dmg|exe)$/u.test(fileName)) {
        throw new Error(`Managed plugin composition cannot bind unsupported artifact ${fileName}.`);
      }
      const stat = NodeFS.statSync(artifactPath);
      if (!stat.isFile() || stat.size <= 0)
        throw new Error(`Harness artifact is not a non-empty file: ${fileName}.`);
      return { fileName, size: stat.size, sha512: await sha512Base64(artifactPath) };
    }),
  );
  artifacts.sort((left, right) => compareText(left.fileName, right.fileName));
  if (new Set(artifacts.map(({ fileName }) => fileName)).size !== artifacts.length) {
    throw new Error("Managed plugin composition artifact names must be unique.");
  }
  return { ...composition, artifacts };
}
