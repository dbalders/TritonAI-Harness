// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
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

function composition(files: ReadonlyArray<TestFile>) {
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
    id: "microsoft-365",
    name: "Microsoft 365",
    version: "1.0.0",
    digest: hash.digest("hex"),
    files: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
  };
}

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-production-plugin-"));
  const entries = [
    [".tritonai-plugin/plugin.json", '{"id":"microsoft-365"}'],
    [
      "dist/index.js",
      'import * as Effect from "effect/Effect"; export const value = Effect.succeed(true);',
    ],
    [
      "package.json",
      '{"name":"@tritonai/microsoft-365","type":"module","dependencies":{"effect":"4.0.0-beta.78"}}',
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
  return { root, files, plugin: composition(files) };
}

describe("production built-in package verification", () => {
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
