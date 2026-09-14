// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { PluginHostRuntimeDependency } from "@t3tools/shared/pluginHostRuntime";

export interface ProductionRuntimeLease {
  readonly root: string;
  readonly release: () => Promise<void>;
}

interface RuntimeSnapshot {
  readonly directory: string;
  readonly root: string;
}

const snapshots = new Map<string, { ready: Promise<RuntimeSnapshot>; users: number }>();

async function copyRuntimeTree(source: string, target: string): Promise<void> {
  const pending = [{ source, target }];
  while (pending.length > 0) {
    const batch = pending.splice(-8);
    const results = await Promise.allSettled(
      batch.map(async (entry) => {
        const stat = await NodeFSP.lstat(entry.source);
        if (stat.isDirectory()) {
          await NodeFSP.mkdir(entry.target, { recursive: true, mode: 0o700 });
          return (await NodeFSP.readdir(entry.source)).map((name) => ({
            source: NodePath.join(entry.source, name),
            target: NodePath.join(entry.target, name),
          }));
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error("Built-in plugin runtime contains a non-regular file.");
        }
        // Electron's patched reads handle both packed files and unpacked native binaries.
        await NodeFSP.writeFile(entry.target, await NodeFSP.readFile(entry.source), {
          flag: "wx",
          mode: 0o400,
        });
        return [];
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      pending.push(...result.value);
    }
  }
}

async function materializeRuntime(manifestPath: string): Promise<RuntimeSnapshot> {
  // Windows stages a hoisted, symlink-free dependency tree in server.asar. Copy only the
  // host runtime's installed dependency closure, once per backend, rather than unpacking
  // thousands of files in the installer or copying them for every plugin.
  const sourceModules = NodePath.dirname(NodePath.dirname(manifestPath));
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "tritonai-plugin-runtime-"),
  );
  const targetModules = NodePath.join(directory, "node_modules");
  try {
    const pending = ["effect"];
    const copied = new Set<string>();
    for (const name of pending) {
      if (copied.has(name)) continue;
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name === "." || name === "..") {
        throw new Error("Built-in plugin runtime dependency name is invalid.");
      }
      copied.add(name);
      const sourceRoot = NodePath.join(sourceModules, ...name.split("/"));
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(sourceRoot, "package.json"), "utf8"),
      ) as {
        name?: unknown;
        dependencies?: Record<string, unknown>;
        optionalDependencies?: Record<string, unknown>;
      };
      if (manifest.name !== name)
        throw new Error("Built-in plugin runtime dependency identity does not match.");
      await copyRuntimeTree(sourceRoot, NodePath.join(targetModules, ...name.split("/")));
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        if (!Object.hasOwn(manifest.optionalDependencies ?? {}, dependency))
          pending.push(dependency);
      }
      for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
        // Optional platform bindings are absent on platforms they do not support.
        if (
          await NodeFSP.access(NodePath.join(sourceModules, dependency, "package.json")).then(
            () => true,
            () => false,
          )
        ) {
          pending.push(dependency);
        }
      }
    }
    return { directory, root: NodePath.join(targetModules, "effect") };
  } catch (error) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function acquireProductionRuntime(
  resolvedManifest: string,
  dependency: PluginHostRuntimeDependency,
): Promise<ProductionRuntimeLease> {
  const archiveSegment = `${NodePath.sep}app.asar${NodePath.sep}`;
  const unpackedManifest = resolvedManifest.replace(
    archiveSegment,
    `${NodePath.sep}app.asar.unpacked${NodePath.sep}`,
  );
  const manifestPath = await NodeFSP.access(unpackedManifest).then(
    () => unpackedManifest,
    () => resolvedManifest,
  );
  const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (manifest.name !== dependency.name || manifest.version !== dependency.version) {
    throw new Error(
      `Built-in plugin runtime dependency version does not match: ${dependency.name}.`,
    );
  }
  const root = await NodeFSP.realpath(NodePath.dirname(manifestPath));
  const stat = await NodeFSP.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Built-in plugin runtime dependency is not a real directory: ${dependency.name}.`,
    );
  }
  if (!root.includes(`${NodePath.sep}server.asar${NodePath.sep}`)) {
    return { root, release: async () => undefined };
  }

  let snapshot = snapshots.get(manifestPath);
  if (!snapshot) {
    snapshot = { ready: materializeRuntime(manifestPath), users: 0 };
    snapshots.set(manifestPath, snapshot);
  }
  snapshot.users += 1;
  const acquired = snapshot;
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    acquired.users -= 1;
    if (acquired.users !== 0) return;
    if (snapshots.get(manifestPath) === acquired) snapshots.delete(manifestPath);
    const ready = await acquired.ready.catch(() => undefined);
    if (ready) await NodeFSP.rm(ready.directory, { recursive: true, force: true });
  };
  try {
    return { root: (await acquired.ready).root, release };
  } catch (error) {
    await release();
    throw error;
  }
}
