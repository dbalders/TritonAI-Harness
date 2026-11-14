// @effect-diagnostics nodeBuiltinImport:off - Exercise build inputs and a relocated bundle in a standalone Node process.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { loadHelpDocumentationForBuild } from "../../../../scripts/lib/help-documentation.ts";

describe("Help documentation build inputs", () => {
  it("includes newly added docs but excludes private files, directories and symlinks", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "help-doc-input-"));
    try {
      const directory = NodePath.join(root, "docs/user");
      await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(directory, "new-feature.md"),
        "# New feature\n\nExact source.",
      );
      await NodeFSP.writeFile(NodePath.join(directory, ".private.md"), "private");
      await NodeFSP.writeFile(NodePath.join(directory, "private.json"), "private");
      await NodeFSP.mkdir(NodePath.join(directory, "folder.md"));
      await NodeFSP.symlink(
        NodePath.join(directory, ".private.md"),
        NodePath.join(directory, "linked.md"),
      );
      expect(loadHelpDocumentationForBuild(root)).toEqual([
        { path: "docs/user/new-feature.md", content: "# New feature\n\nExact source." },
      ]);
      expect(() => loadHelpDocumentationForBuild(NodePath.join(root, "missing"))).toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
