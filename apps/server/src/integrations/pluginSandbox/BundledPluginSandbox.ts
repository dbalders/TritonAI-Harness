// @effect-diagnostics nodeBuiltinImport:off -- Bundled native files are snapshotted before execution.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { createMacPluginSandboxRuntime } from "./MacPluginSandboxRuntime.ts";
import { PluginSandboxBundle } from "@t3tools/shared/pluginSandboxBundle";

export interface PluginSandboxHost {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}
const decodeBundle = Schema.decodeUnknownSync(PluginSandboxBundle);

declare const __TRITONAI_BUILD_PLUGIN_SANDBOX__: unknown;

const builtBundle =
  typeof __TRITONAI_BUILD_PLUGIN_SANDBOX__ === "undefined"
    ? null
    : __TRITONAI_BUILD_PLUGIN_SANDBOX__;

export async function createBundledPluginSandbox(
  directory: string,
  host: PluginSandboxHost,
  input: unknown = builtBundle,
) {
  if (input === null || input === undefined || host.platform !== "darwin") return null;
  const bundle = decodeBundle(input);
  if (bundle.arch !== host.arch)
    throw new Error("The bundled plugin sandbox architecture does not match this host.");
  const root = NodePath.join(directory, "production-integrations", "runtime");
  const pinned = (key: "runtime" | "supervisor" | "bootstrap" | "engine" | "bridge") => ({
    path: NodePath.join(root, bundle.files[key].name),
    sha256: bundle.files[key].sha256,
  });
  return createMacPluginSandboxRuntime({
    platform: host.platform,
    parentDirectory: NodeOS.tmpdir(),
    runtime: pinned("runtime"),
    supervisor: pinned("supervisor"),
    bootstrap: pinned("bootstrap"),
    engine: pinned("engine"),
    bridge: pinned("bridge"),
  });
}
