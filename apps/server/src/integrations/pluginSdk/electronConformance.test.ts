// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const electronRoot = NodePath.resolve(
  import.meta.dirname,
  "../../../../desktop/node_modules/electron",
);
const pathFile = NodePath.join(electronRoot, "path.txt");

describe("plugin SDK Electron runtime conformance", () => {
  it.runIf(NodeFS.existsSync(pathFile))(
    "imports a self-contained data URL with a reviewed Node builtin",
    () => {
      const binary = NodePath.join(
        electronRoot,
        "dist",
        NodeFS.readFileSync(pathFile, "utf8").trim(),
      );
      const source =
        'import { createHash } from "node:crypto"; export const value = createHash("sha256").update("sdk").digest("hex");';
      const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
      const script = [
        `import(${JSON.stringify(moduleUrl)})`,
        ".then(({ value }) => process.stdout.write(JSON.stringify({ node: process.versions.node, value })))",
        ".catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; })",
      ].join("");
      const output = NodeChildProcess.execFileSync(binary, ["-e", script], {
        encoding: "utf8",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      const result = JSON.parse(output) as { readonly node: string; readonly value: string };
      expect(result.node).toMatch(/^24\./u);
      expect(result.value).toBe("a9d0df1873a041a6e38e2c461ffc6b53d216fd7cfab9bece3e9b5bc5c69b4203");
    },
  );
});
