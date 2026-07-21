// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { IntegrationPackage, IntegrationProvider } from "./IntegrationRegistry.ts";
import { scopeIntegrationSecretStore } from "./IntegrationSecretStore.ts";
import { validateIntegrationManifest } from "./manifest.ts";

declare const __TRITONAI_BUILD_PLUGIN_COMPOSITION__: unknown;
declare const __TRITONAI_BUILD_MICROSOFT_GRAPH_CLIENT_ID__: string | undefined;
declare const __TRITONAI_BUILD_MICROSOFT_GRAPH_TENANT_ID__: string | undefined;

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

interface Microsoft365Module {
  readonly MICROSOFT_GRAPH_PROVIDER_ID: string;
  readonly MicrosoftGraphProvider: new (
    secrets: Parameters<typeof scopeIntegrationSecretStore>[0],
    configuration: { readonly clientId: string; readonly tenantId: string },
  ) => IntegrationProvider;
  readonly manifest: unknown;
}

interface RuntimeDependency {
  readonly name: string;
  readonly version: string;
}

const supportedRuntimeDependencies = new Set(["effect"]);

const buildComposition =
  typeof __TRITONAI_BUILD_PLUGIN_COMPOSITION__ === "undefined"
    ? null
    : (__TRITONAI_BUILD_PLUGIN_COMPOSITION__ as ProductionComposition | null);

function buildIdentifier(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

const microsoftGraphConfiguration = {
  clientId: buildIdentifier(
    typeof __TRITONAI_BUILD_MICROSOFT_GRAPH_CLIENT_ID__ === "undefined"
      ? undefined
      : __TRITONAI_BUILD_MICROSOFT_GRAPH_CLIENT_ID__,
  ),
  tenantId: buildIdentifier(
    typeof __TRITONAI_BUILD_MICROSOFT_GRAPH_TENANT_ID__ === "undefined"
      ? undefined
      : __TRITONAI_BUILD_MICROSOFT_GRAPH_TENANT_ID__,
  ),
};

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
): ReadonlyArray<RuntimeDependency> {
  const packageJsonFile = verifiedFiles.find(({ path }) => path === "package.json");
  if (!packageJsonFile) {
    throw new Error(`Built-in plugin ${plugin.id} package.json is missing.`);
  }
  const packageJson = JSON.parse(Buffer.from(packageJsonFile.contents).toString("utf8")) as {
    readonly dependencies?: unknown;
  };
  if (packageJson.dependencies === undefined) return [];
  if (
    !packageJson.dependencies ||
    typeof packageJson.dependencies !== "object" ||
    Array.isArray(packageJson.dependencies)
  ) {
    throw new Error(`Built-in plugin ${plugin.id} dependencies are invalid.`);
  }
  return Object.entries(packageJson.dependencies)
    .map(([name, version]): RuntimeDependency => {
      if (
        !supportedRuntimeDependencies.has(name) ||
        typeof version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
      ) {
        throw new Error(`Built-in plugin ${plugin.id} dependency is unsupported: ${name}.`);
      }
      return { name, version };
    })
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

async function resolveRuntimeDependencyRoot(dependency: RuntimeDependency): Promise<string> {
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

async function loadMicrosoft365(
  plugin: CompositionPackage,
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Promise<IntegrationPackage> {
  const composedPackageRoot = NodePath.join(
    import.meta.dirname,
    "production-integrations",
    "packages",
    plugin.id,
  );
  return withProductionPackageSnapshot(
    composedPackageRoot,
    plugin,
    async (packageRoot, verifiedFiles) => {
      const packageManifest = validateIntegrationManifest(
        JSON.parse(
          await NodeFSP.readFile(
            NodePath.join(packageRoot, ".tritonai-plugin", "plugin.json"),
            "utf8",
          ),
        ),
      );
      const moduleUrl = NodeURL.pathToFileURL(NodePath.join(packageRoot, "dist", "index.js")).href;
      const loaded = (await import(moduleUrl)) as Microsoft365Module;
      const exportedManifest = validateIntegrationManifest(loaded.manifest);
      if (
        !NodeUtil.isDeepStrictEqual(exportedManifest, packageManifest) ||
        packageManifest.id !== plugin.id ||
        packageManifest.version !== plugin.version ||
        loaded.MICROSOFT_GRAPH_PROVIDER_ID !== packageManifest.provider
      ) {
        throw new Error(
          "Built-in Microsoft 365 provider exports do not match the composed manifest.",
        );
      }
      const provider = new loaded.MicrosoftGraphProvider(
        scopeIntegrationSecretStore(secrets, packageManifest.id),
        microsoftGraphConfiguration,
      );
      const bundledFiles = Object.fromEntries(
        verifiedFiles.map((file) => [file.path, Uint8Array.from(file.contents)]),
      );
      return { manifest: packageManifest, bundledFiles, provider };
    },
  );
}

export async function loadProductionIntegrations(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Promise<ReadonlyArray<IntegrationPackage>> {
  if (!buildComposition) return [];
  if (
    buildComposition.version !== 1 ||
    buildComposition.kind !== "tritonai-harness-plugin-composition" ||
    buildComposition.source.repository !== "https://github.com/dbalders/TritonAI-Plugins.git"
  ) {
    throw new Error("Built-in plugin composition has an unsupported contract or provenance.");
  }
  const result: Array<IntegrationPackage> = [];
  for (const plugin of buildComposition.packages) {
    if (plugin.id !== "microsoft-365") {
      throw new Error(`Built-in plugin is not statically supported: ${plugin.id}.`);
    }
    result.push(await loadMicrosoft365(plugin, secrets));
  }
  return result;
}

export function productionIntegrationCompositionForTest(): ProductionComposition | null {
  return buildComposition;
}
