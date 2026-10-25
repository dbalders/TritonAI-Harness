// @effect-diagnostics nodeBuiltinImport:off - fast-path resolution runs before the Effect CLI/runtime.
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";

export interface ServerWorkerCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly limitsVia?: "arguments" | "environment";
}

// A SEA is its own entry; Node and Electron-as-node need the verified server entry.
export function resolveServerWorkerCommand(command: string): ServerWorkerCommand | null {
  if (NodeSea.isSea()) {
    return { command: process.execPath, args: [command], limitsVia: "environment" };
  }
  const entry = process.argv[1];
  if (!entry || !/^bin\.(?:m?js|ts)$/u.test(NodePath.basename(entry))) return null;
  return { command: process.execPath, args: [entry, command] };
}
