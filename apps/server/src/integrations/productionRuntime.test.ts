// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";

import { acquireProductionRuntime } from "./productionRuntime.ts";

const dependency = { name: "effect", version: "4.0.0-beta.103", declaration: "peer" } as const;

async function fixture(archive = "server.asar") {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-runtime-test-"));
  const modules = NodePath.join(root, archive, "node_modules");
  const effectRoot = NodePath.join(modules, "effect");
  const manifestPath = NodePath.join(effectRoot, "package.json");
  await NodeFSP.mkdir(effectRoot, { recursive: true });
  await NodeFSP.writeFile(
    manifestPath,
    JSON.stringify({
      name: dependency.name,
      version: dependency.version,
      type: "module",
      dependencies: { "runtime-helper": "1.0.0" },
      optionalDependencies: { "absent-platform-binding": "1.0.0" },
    }),
  );
  await NodeFSP.writeFile(
    NodePath.join(effectRoot, "index.mjs"),
    'export { value } from "runtime-helper";',
  );
  const helperRoot = NodePath.join(modules, "runtime-helper");
  await NodeFSP.mkdir(helperRoot);
  await NodeFSP.writeFile(
    NodePath.join(helperRoot, "package.json"),
    JSON.stringify({
      name: "runtime-helper",
      version: "1.0.0",
      type: "module",
      exports: "./index.mjs",
    }),
  );
  await NodeFSP.writeFile(NodePath.join(helperRoot, "index.mjs"), "export const value = 42;");
  return {
    root,
    effectRoot,
    helperRoot,
    manifestPath,
    close: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

describe("packaged production plugin runtime", () => {
  it("materializes the archived dependency closure once and retains it until the last provider closes", async () => {
    const files = await fixture();
    try {
      const [first, second] = await Promise.all([
        acquireProductionRuntime(files.manifestPath, dependency),
        acquireProductionRuntime(files.manifestPath, dependency),
      ]);
      try {
        expect(first.root).toBe(second.root);
        expect(first.root).not.toBe(files.effectRoot);
        expect(first.root).not.toContain("server.asar");
        const loaded = await import(
          NodeURL.pathToFileURL(NodePath.join(first.root, "index.mjs")).href
        );
        expect(loaded.value).toBe(42);
        await first.release();
        await first.release();
        await expect(
          NodeFSP.access(NodePath.join(second.root, "index.mjs")),
        ).resolves.toBeUndefined();
      } finally {
        await first.release();
        await second.release();
      }
      await expect(NodeFSP.access(first.root)).rejects.toThrow();
      await expect(NodeFSP.access(files.manifestPath)).resolves.toBeUndefined();
    } finally {
      await files.close();
    }
  });

  it("uses the real WSL dependency tree directly", async () => {
    const files = await fixture("extracted-server");
    try {
      const lease = await acquireProductionRuntime(files.manifestPath, dependency);
      expect(lease.root).toBe(await NodeFSP.realpath(files.effectRoot));
      await lease.release();
      await expect(NodeFSP.access(files.effectRoot)).resolves.toBeUndefined();
    } finally {
      await files.close();
    }
  });

  it("keeps using the unpacked macOS host runtime", async () => {
    const files = await fixture("app.asar.unpacked");
    try {
      const lease = await acquireProductionRuntime(
        files.manifestPath.replace("app.asar.unpacked", "app.asar"),
        dependency,
      );
      expect(lease.root).toBe(await NodeFSP.realpath(files.effectRoot));
      await lease.release();
    } finally {
      await files.close();
    }
  });

  it("does not retain a failed extraction and can retry after a missing dependency is restored", async () => {
    const files = await fixture();
    const helperManifest = NodePath.join(files.helperRoot, "package.json");
    try {
      const saved = await NodeFSP.readFile(helperManifest);
      await NodeFSP.unlink(helperManifest);
      await expect(acquireProductionRuntime(files.manifestPath, dependency)).rejects.toThrow();
      await NodeFSP.writeFile(helperManifest, saved);
      const lease = await acquireProductionRuntime(files.manifestPath, dependency);
      try {
        const loaded = await import(
          NodeURL.pathToFileURL(NodePath.join(lease.root, "index.mjs")).href
        );
        expect(loaded.value).toBe(42);
      } finally {
        await lease.release();
      }
    } finally {
      await files.close();
    }
  });

  it("rejects a runtime version that differs from the build", async () => {
    const files = await fixture();
    try {
      await expect(
        acquireProductionRuntime(files.manifestPath, { ...dependency, version: "4.0.0-beta.78" }),
      ).rejects.toThrow("version does not match");
    } finally {
      await files.close();
    }
  });
});
