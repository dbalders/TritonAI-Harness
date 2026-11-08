// @effect-diagnostics nodeBuiltinImport:off - Exercise build inputs and a relocated bundle in a standalone Node process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { build } from "vite-plus/pack";

import serverConfig from "../../vite.config.ts";
import { loadHelpDocumentationForBuild } from "../../../../scripts/lib/help-documentation.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("../../../..", import.meta.url));
const require = NodeModule.createRequire(import.meta.url);

describe("Help documentation build inputs", () => {
  it("discovers all public guides automatically and embeds their exact source through pack.define", async () => {
    const catalog = loadHelpDocumentationForBuild(repoRoot);
    const names = (await NodeFSP.readdir(NodePath.join(repoRoot, "docs/user")))
      .filter((name) => name.endsWith(".md"))
      .sort();
    expect(catalog.map((doc) => doc.path)).toEqual(names.map((name) => `docs/user/${name}`));
    for (const doc of catalog) {
      expect(doc.content).toBe(await NodeFSP.readFile(NodePath.join(repoRoot, doc.path), "utf8"));
    }
    expect(
      JSON.parse(serverConfig.pack!.define!.__TRITONAI_HELP_DOCUMENTATION__ as string),
    ).toEqual(catalog);
  });

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

  it("runs relocated packed retrieval without checkout, and never falls back when the define is missing", async () => {
    const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "help-doc-package-"));
    try {
      const entry = NodePath.join(scratch, "probe.mjs");
      await NodeFSP.writeFile(
        entry,
        `
        import * as Effect from ${JSON.stringify(require.resolve("effect/Effect"))};
        import * as FileSystem from ${JSON.stringify(require.resolve("effect/FileSystem"))};
        import * as Docs from ${JSON.stringify(NodePath.join(repoRoot, "apps/server/src/help/HelpDocumentation.ts"))};
        const result = await Effect.runPromise(Effect.gen(function* () {
          const docs = yield* Docs.HelpDocumentation;
          return yield* Effect.all([
            docs.search('i saw someone have their app use a mouse for them, how do i do that'),
            docs.search('is that not computer use?'),
            docs.search('What permissions do I need?', 'Use Computer use in Settings > General to control the mouse.'),
            docs.search('How do I clean up old worktrees?'),
          ]);
        }).pipe(Effect.provide(Docs.layer), Effect.provide(FileSystem.layerNoop({
          realPath: () => Effect.die('Packaged Help must not touch the filesystem'),
          readDirectory: () => Effect.die('Packaged Help must not touch the filesystem'),
          readFileString: () => Effect.die('Packaged Help must not touch the filesystem'),
        }))));
        console.log(JSON.stringify(result));
      `,
      );
      for (const [name, define] of [
        [
          "embedded",
          {
            __TRITONAI_HELP_DOCUMENTATION__:
              serverConfig.pack!.define!.__TRITONAI_HELP_DOCUMENTATION__,
          },
        ],
        ["missing", {}],
        ["unavailable", { __TRITONAI_HELP_DOCUMENTATION__: "null" }],
      ] as const) {
        const outDir = NodePath.join(scratch, name);
        await build({
          config: false,
          entry: [entry],
          outDir,
          platform: "node",
          format: "esm",
          dts: false,
          logLevel: "error",
          define,
          deps: { alwaysBundle: () => true, onlyBundle: false },
        });
        const output = NodeChildProcess.execFileSync(
          process.execPath,
          [NodePath.join(outDir, "probe.mjs")],
          {
            cwd: scratch,
            encoding: "utf8",
            timeout: 30_000,
          },
        );
        const results = JSON.parse(output);
        if (name === "embedded") {
          const computerUse = await NodeFSP.readFile(
            NodePath.join(repoRoot, "docs/user/computer-use.md"),
            "utf8",
          );
          for (const result of results.slice(0, 3)) {
            expect(result.documentationStatus).toBe("available");
            expect(result.documentation[0].path).toBe("docs/user/computer-use.md");
            expect(result.documentation[0].content).toBe(computerUse);
          }
          const settings = await NodeFSP.readFile(
            NodePath.join(repoRoot, "docs/user/project-settings.md"),
            "utf8",
          );
          const cleanup = /^## Storage cleanup\n[\s\S]*?(?=\n## |$)/m.exec(settings)![0].trim();
          expect(
            results[3].documentation.find(
              (doc: { path: string }) => doc.path === "docs/user/project-settings.md",
            )?.content,
          ).toContain(cleanup);
          for (const result of results) {
            expect(result.documentation.length).toBeLessThanOrEqual(8);
            expect(
              result.documentation.reduce(
                (size: number, doc: { content: string }) => size + doc.content.length,
                0,
              ),
            ).toBeLessThanOrEqual(20_000);
            for (const doc of result.documentation)
              expect(doc.content.length).toBeLessThanOrEqual(16_000);
          }
        } else
          for (const result of results)
            expect(result).toEqual({ documentationStatus: "unavailable", documentation: [] });
      }
    } finally {
      await NodeFSP.rm(scratch, { recursive: true, force: true });
    }
  });

  it("rejects release inputs that the runtime could not index", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "help-doc-invalid-"));
    try {
      const directory = NodePath.join(root, "docs/user");
      await NodeFSP.mkdir(directory, { recursive: true });
      expect(() => loadHelpDocumentationForBuild(root)).toThrow("requires public");
      const file = NodePath.join(directory, "guide.md");
      await NodeFSP.writeFile(file, "No Markdown title.");
      expect(() => loadHelpDocumentationForBuild(root)).toThrow("invalid title");
      await NodeFSP.writeFile(file, `# Guide\n\n${"x".repeat(256_000)}`);
      expect(() => loadHelpDocumentationForBuild(root)).toThrow("size");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
