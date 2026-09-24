// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";

/** Keep async plugin evaluation in the disk module loader when running as a SEA. */
export function importPluginModule(moduleUrl: string): Promise<unknown> {
  if (!NodeSea.isSea()) return import(moduleUrl);
  // Node SEA's own import() can resolve builtins only. The adjacent loader is
  // emitted by the build CLI and copied into the self-contained runtime archive.
  const loader = NodeModule.createRequire(import.meta.url)("./plugin-module-loader.cjs") as {
    importPluginModule: (specifier: string) => Promise<unknown>;
  };
  return loader.importPluginModule(moduleUrl);
}
