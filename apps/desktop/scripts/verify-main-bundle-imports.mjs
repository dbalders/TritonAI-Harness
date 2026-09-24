import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { parse } from "acorn";

const mainUrl = new URL("../dist-electron/main.cjs", import.meta.url);
const requireFromMain = NodeModule.createRequire(mainUrl);

// The native Cua SDK stays external and exports ESM only. A successful CJS build
// can still emit require() calls that fail before Electron creates a window.
export function verifyMainBundleImports(source) {
  const visit = (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments[0]?.type === "Literal" &&
      typeof node.arguments[0].value === "string" &&
      /^@trycua\/cua-driver(?:\/|$)/u.test(node.arguments[0].value)
    ) {
      requireFromMain.resolve(node.arguments[0].value);
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === "object" && typeof child.type === "string") {
          visit(child);
        }
      }
    }
  };
  visit(parse(source, { ecmaVersion: "latest", sourceType: "script" }));
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  verifyMainBundleImports(await NodeFSP.readFile(mainUrl, "utf8"));
}
