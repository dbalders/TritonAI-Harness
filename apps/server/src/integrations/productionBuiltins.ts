// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  type PluginPackageRuntimeMetadata,
  resolvePluginHostRuntimeDependencies,
} from "@t3tools/shared/pluginHostRuntime";
import { hasPluginSdkArtifact } from "@t3tools/shared/pluginSdkArtifact";
import effectPackageJson from "effect/package.json" with { type: "json" };

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { IntegrationPackage, IntegrationProvider } from "./IntegrationRegistry.ts";
import { scopeIntegrationSecretStore } from "./IntegrationSecretStore.ts";
import { validateIntegrationManifest } from "./manifest.ts";
import { loadPluginSdkIntegration, PluginSdkQuarantineError } from "./pluginSdk/adapter.ts";

declare const __TRITONAI_BUILD_PLUGIN_COMPOSITION__: unknown;
declare const __TRITONAI_BUILD_PLUGIN_CONFIGURATION__: unknown;

interface CompositionFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface DescribedCompositionFile extends CompositionFile {
  readonly contents: Uint8Array;
}

interface CompositionPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly files: ReadonlyArray<CompositionFile>;
}

interface ProductionComposition {
  readonly version: 1;
  readonly kind: "tritonai-harness-plugin-composition";
  readonly source: {
    readonly repository: "https://github.com/dbalders/TritonAI-Plugins.git";
    readonly ref: string;
    readonly commit: string;
  };
  readonly packages: ReadonlyArray<CompositionPackage>;
}

interface IntegrationPluginModule {
  readonly createIntegrationProvider?: (input: {
    readonly secrets: ReturnType<typeof scopeIntegrationSecretStore>;
    readonly configuration: unknown;
  }) => IntegrationProvider;
  readonly manifest: unknown;
}

const buildComposition =
  typeof __TRITONAI_BUILD_PLUGIN_COMPOSITION__ === "undefined"
    ? null
    : (__TRITONAI_BUILD_PLUGIN_COMPOSITION__ as ProductionComposition | null);

const buildConfiguration =
  typeof __TRITONAI_BUILD_PLUGIN_CONFIGURATION__ === "undefined"
    ? null
    : (__TRITONAI_BUILD_PLUGIN_CONFIGURATION__ as Readonly<Record<string, unknown>> | null);

function isSafeCompositionPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !NodePath.posix.isAbsolute(value) &&
    value
      .split("/")
      .every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    NodePath.posix.normalize(value) === value
  );
}

async function describePackageFiles(
  packageRoot: string,
  relative = "",
): Promise<ReadonlyArray<DescribedCompositionFile>> {
  const result: Array<DescribedCompositionFile> = [];
  const entries = await NodeFSP.readdir(
    NodePath.join(packageRoot, ...relative.split("/").filter(Boolean)),
    {
      withFileTypes: true,
    },
  );
  for (const entry of entries) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const target = NodePath.join(packageRoot, ...childRelative.split("/"));
    const stat = await NodeFSP.lstat(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`Built-in plugin package contains a symbolic link: ${childRelative}.`);
    }
    if (stat.isDirectory()) {
      result.push(...(await describePackageFiles(packageRoot, childRelative)));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Built-in plugin package contains a special file: ${childRelative}.`);
    }
    const contents = await NodeFSP.readFile(target);
    if (contents.byteLength !== stat.size) {
      throw new Error(
        `Built-in plugin file changed while it was being verified: ${childRelative}.`,
      );
    }
    result.push({
      path: childRelative,
      sha256: NodeCrypto.createHash("sha256").update(contents).digest("hex"),
      size: stat.size,
      contents,
    });
  }
  return result.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function packageDigest(files: ReadonlyArray<DescribedCompositionFile>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(String(file.size), "utf8");
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function verifyDescribedPackage(
  plugin: CompositionPackage,
  actualFiles: ReadonlyArray<DescribedCompositionFile>,
): void {
  if (actualFiles.length !== plugin.files.length) {
    throw new Error(`Built-in plugin ${plugin.id} file inventory does not match its package.`);
  }
  for (let index = 0; index < actualFiles.length; index += 1) {
    const actual = actualFiles[index]!;
    const expected = plugin.files[index]!;
    if (
      actual.path !== expected.path ||
      actual.size !== expected.size ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(`Built-in plugin ${plugin.id} file verification failed: ${actual.path}.`);
    }
  }
  if (packageDigest(actualFiles) !== plugin.digest) {
    throw new Error(`Built-in plugin ${plugin.id} package digest verification failed.`);
  }
}

async function verifiedPackageFiles(
  packageRoot: string,
  plugin: CompositionPackage,
): Promise<ReadonlyArray<DescribedCompositionFile>> {
  const rootStat = await NodeFSP.lstat(packageRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Built-in plugin ${plugin.id} package root is not a real directory.`);
  }
  if (!/^[0-9a-f]{64}$/.test(plugin.digest)) {
    throw new Error(`Built-in plugin ${plugin.id} package digest is invalid.`);
  }
  for (let index = 0; index < plugin.files.length; index += 1) {
    const file = plugin.files[index]!;
    const previous = plugin.files[index - 1];
    if (
      !isSafeCompositionPath(file.path) ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      (previous && previous.path >= file.path)
    ) {
      throw new Error(`Built-in plugin ${plugin.id} file inventory is invalid.`);
    }
  }

  const actualFiles = await describePackageFiles(packageRoot);
  verifyDescribedPackage(plugin, actualFiles);
  return actualFiles;
}

export async function verifyProductionPackageForTest(
  packageRoot: string,
  plugin: CompositionPackage,
): Promise<void> {
  await verifiedPackageFiles(packageRoot, plugin);
}

async function sealSnapshotDirectory(directory: string): Promise<void> {
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) await sealSnapshotDirectory(target);
    else await NodeFSP.chmod(target, 0o400);
  }
  await NodeFSP.chmod(directory, 0o500);
}

function runtimeDependencies(
  plugin: CompositionPackage,
  verifiedFiles: ReadonlyArray<DescribedCompositionFile>,
): ReturnType<typeof resolvePluginHostRuntimeDependencies> {
  const packageJson = verifiedPackageRuntimeMetadata(plugin, verifiedFiles);
  try {
    return resolvePluginHostRuntimeDependencies(packageJson, effectPackageJson.version);
  } catch (error) {
    throw new Error(`Built-in plugin ${plugin.id} host runtime contract is invalid.`, {
      cause: error,
    });
  }
}

function verifiedPackageRuntimeMetadata(
  plugin: CompositionPackage,
  verifiedFiles: ReadonlyArray<DescribedCompositionFile>,
): PluginPackageRuntimeMetadata {
  const packageJsonFile = verifiedFiles.find(({ path }) => path === "package.json");
  if (!packageJsonFile) {
    throw new Error(`Built-in plugin ${plugin.id} package.json is missing.`);
  }
  const packageJson = JSON.parse(Buffer.from(packageJsonFile.contents).toString("utf8")) as unknown;
  if (!isRecord(packageJson)) {
    throw new Error(`Built-in plugin ${plugin.id} package.json must be an object.`);
  }
  return packageJson;
}

function validateProviderlessRuntimeMetadata(
  plugin: CompositionPackage,
  verifiedFiles: ReadonlyArray<DescribedCompositionFile>,
): void {
  const packageJson = verifiedPackageRuntimeMetadata(plugin, verifiedFiles);
  const dependencyMetadata = [
    packageJson.dependencies,
    packageJson.peerDependencies,
    packageJson.optionalDependencies,
  ];
  const bundledMetadata = [packageJson.bundledDependencies, packageJson.bundleDependencies];
  if (
    dependencyMetadata.some(
      (value) => value !== undefined && (!isRecord(value) || Object.keys(value).length > 0),
    ) ||
    bundledMetadata.some(
      (value) => value !== undefined && (!Array.isArray(value) || value.length > 0),
    )
  ) {
    throw new Error(
      `Built-in plugin ${plugin.id} cannot declare runtime metadata without a provider.`,
    );
  }
}

async function resolveRuntimeDependencyRoot(
  dependency: ReturnType<typeof resolvePluginHostRuntimeDependencies>[number],
): Promise<string> {
  const resolvedManifest = NodeURL.fileURLToPath(
    import.meta.resolve(`${dependency.name}/package.json`),
  );
  const asarSegment = `${NodePath.sep}app.asar${NodePath.sep}`;
  const unpackedManifest = resolvedManifest.includes(asarSegment)
    ? resolvedManifest.replace(asarSegment, `${NodePath.sep}app.asar.unpacked${NodePath.sep}`)
    : resolvedManifest;
  const manifestPath = await NodeFSP.access(unpackedManifest)
    .then(() => unpackedManifest)
    .catch(() => resolvedManifest);
  const packageRoot = await NodeFSP.realpath(NodePath.dirname(manifestPath));
  const stat = await NodeFSP.lstat(packageRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Built-in plugin runtime dependency is not a real directory: ${dependency.name}.`,
    );
  }
  const packageJson = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as {
    readonly name?: unknown;
    readonly version?: unknown;
  };
  if (packageJson.name !== dependency.name || packageJson.version !== dependency.version) {
    throw new Error(
      `Built-in plugin runtime dependency version does not match: ${dependency.name}.`,
    );
  }
  return packageRoot;
}

async function linkSnapshotRuntimeDependencies(
  snapshotParent: string,
  plugin: CompositionPackage,
  verifiedFiles: ReadonlyArray<DescribedCompositionFile>,
): Promise<void> {
  const dependencies = runtimeDependencies(plugin, verifiedFiles);
  if (dependencies.length === 0) return;
  const nodeModulesRoot = NodePath.join(snapshotParent, "node_modules");
  await NodeFSP.mkdir(nodeModulesRoot, { mode: 0o700 });
  const createdDirectories = new Set([nodeModulesRoot]);
  for (const dependency of dependencies) {
    const linkPath = NodePath.join(nodeModulesRoot, ...dependency.name.split("/"));
    const linkParent = NodePath.dirname(linkPath);
    await NodeFSP.mkdir(linkParent, { recursive: true, mode: 0o700 });
    createdDirectories.add(linkParent);
    await NodeFSP.symlink(await resolveRuntimeDependencyRoot(dependency), linkPath, "junction");
  }
  for (const directory of [...createdDirectories].toSorted().toReversed()) {
    await NodeFSP.chmod(directory, 0o500);
  }
}

async function makeSnapshotDirectoriesWritable(directory: string): Promise<void> {
  await NodeFSP.chmod(directory, 0o700);
  const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await makeSnapshotDirectoriesWritable(NodePath.join(directory, entry.name));
    }
  }
}

async function removeProductionPackageSnapshot(snapshotRoot: string): Promise<void> {
  const snapshotParent = NodePath.dirname(snapshotRoot);
  await makeSnapshotDirectoriesWritable(snapshotParent);
  await NodeFSP.rm(snapshotParent, { recursive: true, force: true });
}

async function materializeProductionPackageSnapshot(
  plugin: CompositionPackage,
  verifiedFiles: ReadonlyArray<DescribedCompositionFile>,
): Promise<string> {
  const snapshotParent = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "tritonai-production-plugin-"),
  );
  const snapshotRoot = NodePath.join(snapshotParent, plugin.id);
  try {
    await NodeFSP.mkdir(snapshotRoot, { mode: 0o700 });
    for (const file of verifiedFiles) {
      const target = NodePath.join(snapshotRoot, ...file.path.split("/"));
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 });
      await NodeFSP.writeFile(target, file.contents, { flag: "wx", mode: 0o400 });
    }

    const snapshotFiles = await describePackageFiles(snapshotRoot);
    verifyDescribedPackage(plugin, snapshotFiles);
    await sealSnapshotDirectory(snapshotRoot);
    await linkSnapshotRuntimeDependencies(snapshotParent, plugin, verifiedFiles);
    await NodeFSP.chmod(snapshotParent, 0o500);
    return snapshotRoot;
  } catch (error) {
    await makeSnapshotDirectoriesWritable(snapshotParent).catch(() => undefined);
    await NodeFSP.rm(snapshotParent, { recursive: true, force: true });
    throw error;
  }
}

async function withProductionPackageSnapshot<T>(
  composedPackageRoot: string,
  plugin: CompositionPackage,
  use: (snapshotRoot: string, verifiedFiles: ReadonlyArray<DescribedCompositionFile>) => Promise<T>,
): Promise<T> {
  const verifiedFiles = await verifiedPackageFiles(composedPackageRoot, plugin);
  const snapshotRoot = await materializeProductionPackageSnapshot(plugin, verifiedFiles);
  try {
    return await use(snapshotRoot, verifiedFiles);
  } finally {
    await removeProductionPackageSnapshot(snapshotRoot);
  }
}

export async function withProductionPackageSnapshotForTest<T>(
  composedPackageRoot: string,
  plugin: CompositionPackage,
  use: (snapshotRoot: string) => Promise<T>,
): Promise<T> {
  return withProductionPackageSnapshot(composedPackageRoot, plugin, use);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    Boolean(value) &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function retainSnapshotUntilProviderClose(
  provider: IntegrationProvider,
  snapshotRoot: string,
): IntegrationProvider {
  const originalClose =
    typeof provider.close === "function" ? provider.close.bind(provider) : undefined;
  let closePromise: Promise<void> | undefined;
  const boundMethods = new Map<PropertyKey, (...args: ReadonlyArray<unknown>) => unknown>();

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      let providerCloseFailed = false;
      let providerCloseError: unknown;
      try {
        await originalClose?.();
      } catch (error) {
        providerCloseFailed = true;
        providerCloseError = error;
      }

      let snapshotCleanupFailed = false;
      let snapshotCleanupError: unknown;
      try {
        await removeProductionPackageSnapshot(snapshotRoot);
      } catch (error) {
        snapshotCleanupFailed = true;
        snapshotCleanupError = error;
      }

      if (providerCloseFailed && snapshotCleanupFailed) {
        throw new AggregateError(
          [providerCloseError, snapshotCleanupError],
          "Provider close and built-in plugin snapshot cleanup both failed.",
        );
      }
      if (providerCloseFailed) throw providerCloseError;
      if (snapshotCleanupFailed) throw snapshotCleanupError;
    })();
    return closePromise;
  };

  return new Proxy({} as IntegrationProvider, {
    get(_target, property) {
      if (property === "close") return close;
      const value = Reflect.get(provider, property, provider) as unknown;
      if (typeof value !== "function") return value;
      const existing = boundMethods.get(property);
      if (existing) return existing;
      const bound = value.bind(provider) as (...args: ReadonlyArray<unknown>) => unknown;
      boundMethods.set(property, bound);
      return bound;
    },
    has(_target, property) {
      return property === "close" || property in provider;
    },
  });
}

function validateBuildConfiguration(
  composition: ProductionComposition,
  value: unknown,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  if (!isRecord(value)) {
    throw new Error("Built-in plugin configuration must be an object.");
  }
  const expectedIds = composition.packages.map(({ id }) => id);
  const actualIds = Object.keys(value).toSorted();
  if (!NodeUtil.isDeepStrictEqual(actualIds, expectedIds)) {
    throw new Error("Built-in plugin configuration must exactly match the composed packages.");
  }
  for (const id of expectedIds) {
    if (!isRecord(value[id])) {
      throw new Error(`Built-in plugin configuration for ${id} must be an object.`);
    }
  }
  return value as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

async function loadProductionPackage(
  composedPackageRoot: string,
  plugin: CompositionPackage,
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  configuration: Readonly<Record<string, unknown>>,
  sdkHostNodeVersion?: string | null,
): Promise<IntegrationPackage> {
  const verifiedFiles = await verifiedPackageFiles(composedPackageRoot, plugin);
  if (hasPluginSdkArtifact(verifiedFiles)) {
    return loadPluginSdkIntegration({
      files: verifiedFiles,
      secrets,
      configuration,
      expected: plugin,
      ...(sdkHostNodeVersion === undefined ? {} : { hostNodeVersion: sdkHostNodeVersion }),
    });
  }
  const packageManifestFile = verifiedFiles.find(
    ({ path }) => path === ".tritonai-plugin/plugin.json",
  );
  if (!packageManifestFile) {
    throw new Error(`Built-in plugin ${plugin.id} manifest is missing.`);
  }
  const packageManifest = validateIntegrationManifest(
    JSON.parse(Buffer.from(packageManifestFile.contents).toString("utf8")),
  );
  if (packageManifest.id !== plugin.id || packageManifest.version !== plugin.version) {
    throw new Error(`Built-in plugin ${plugin.id} manifest does not match its composition.`);
  }
  const bundledFiles = Object.fromEntries(
    verifiedFiles.map((file) => [file.path, Uint8Array.from(file.contents)]),
  );

  if (!packageManifest.provider) {
    if (verifiedFiles.some(({ path }) => path.startsWith("dist/"))) {
      throw new Error(
        `Built-in plugin ${plugin.id} includes provider distribution files without declaring a provider.`,
      );
    }
    validateProviderlessRuntimeMetadata(plugin, verifiedFiles);
    return { manifest: packageManifest, bundledFiles };
  }

  const packageRoot = await materializeProductionPackageSnapshot(plugin, verifiedFiles);
  let retainSnapshot = false;
  try {
    const moduleUrl = NodeURL.pathToFileURL(NodePath.join(packageRoot, "dist", "index.js")).href;
    const loaded = (await import(moduleUrl)) as IntegrationPluginModule;
    const exportedManifest = validateIntegrationManifest(loaded.manifest);
    if (!NodeUtil.isDeepStrictEqual(exportedManifest, packageManifest)) {
      throw new Error(`Built-in plugin ${plugin.id} exports do not match its composed manifest.`);
    }
    if (typeof loaded.createIntegrationProvider !== "function") {
      throw new Error(`Built-in plugin ${plugin.id} does not export its provider factory.`);
    }
    const created = loaded.createIntegrationProvider({
      secrets: scopeIntegrationSecretStore(secrets, packageManifest.id),
      configuration,
    });
    if (isPromiseLike(created)) {
      // The factory contract is synchronous, but an async function has already started by the time
      // its thenable result is observable. Consume a late rejection so a malformed plugin cannot
      // turn this deterministic startup validation error into an unhandled process rejection.
      void Promise.resolve(created).catch(() => undefined);
      throw new Error(`Built-in plugin ${plugin.id} provider factory must be synchronous.`);
    }
    if (!isRecord(created) || created.id !== packageManifest.provider) {
      throw new Error(
        `Built-in plugin ${plugin.id} provider does not match its composed manifest.`,
      );
    }
    const provider = retainSnapshotUntilProviderClose(
      created as unknown as IntegrationProvider,
      packageRoot,
    );
    retainSnapshot = true;
    return { manifest: packageManifest, bundledFiles, provider };
  } finally {
    if (!retainSnapshot) await removeProductionPackageSnapshot(packageRoot);
  }
}

export async function loadProductionPackageForTest(
  composedPackageRoot: string,
  plugin: CompositionPackage,
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  configuration: Readonly<Record<string, unknown>>,
  sdkHostNodeVersion?: string | null,
): Promise<IntegrationPackage> {
  return loadProductionPackage(
    composedPackageRoot,
    plugin,
    secrets,
    configuration,
    sdkHostNodeVersion,
  );
}

async function loadProductionPackages(
  loaders: ReadonlyArray<() => Promise<IntegrationPackage>>,
): Promise<ReadonlyArray<IntegrationPackage>> {
  const loaded: Array<IntegrationPackage> = [];
  try {
    for (const load of loaders) {
      try {
        loaded.push(await load());
      } catch (error) {
        if (!(error instanceof PluginSdkQuarantineError)) throw error;
      }
    }
    return loaded;
  } catch (error) {
    await Promise.allSettled(
      loaded.map(({ provider }) => Promise.resolve().then(() => provider?.close?.())),
    );
    throw error;
  }
}

export async function loadProductionPackagesForTest(
  loaders: ReadonlyArray<() => Promise<IntegrationPackage>>,
): Promise<ReadonlyArray<IntegrationPackage>> {
  return loadProductionPackages(loaders);
}

export async function loadProductionIntegrations(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Promise<ReadonlyArray<IntegrationPackage>> {
  if (!buildComposition) return [];
  try {
    if (
      buildComposition.version !== 1 ||
      buildComposition.kind !== "tritonai-harness-plugin-composition" ||
      buildComposition.source.repository !== "https://github.com/dbalders/TritonAI-Plugins.git"
    ) {
      throw new Error("Built-in plugin composition has an unsupported contract or provenance.");
    }
    const configuration = validateBuildConfiguration(buildComposition, buildConfiguration);
    return await loadProductionPackages(
      buildComposition.packages.map((plugin) => {
        const composedPackageRoot = NodePath.join(
          import.meta.dirname,
          "production-integrations",
          "packages",
          plugin.id,
        );
        return () =>
          loadProductionPackage(composedPackageRoot, plugin, secrets, configuration[plugin.id]!);
      }),
    );
  } catch {
    // Build-time validation should make this unreachable. If signed resources are corrupted or a
    // proof contract drifts, keep the core product available and disable the complete integration
    // composition instead of executing a partially trusted set.
    process.stderr.write(
      "Managed plugin composition verification failed; integrations are disabled.\n",
    );
    return [];
  }
}

export function productionIntegrationCompositionForTest(): ProductionComposition | null {
  return buildComposition;
}
