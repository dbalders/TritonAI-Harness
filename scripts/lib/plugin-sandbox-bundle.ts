// @effect-diagnostics nodeBuiltinImport:off -- Build-time validation runs before the server Effect runtime exists.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { PluginSandboxBundle } from "@t3tools/shared/pluginSandboxBundle";
import { QUICKJS_RUNTIME_FILES } from "@t3tools/shared/pluginSandboxProfile";

export const PLUGIN_SANDBOX_SOURCE_ENV = "TRITONAI_PLUGIN_SANDBOX_SOURCE";
export const NODE_SANDBOX_ARCHIVES = {
  arm64: "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
  x64: "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035",
} as const;
const decodeBundle = Schema.decodeUnknownSync(Schema.fromJsonString(PluginSandboxBundle));

export function loadPluginSandboxBundleForBuild(
  repoRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const source = environment[PLUGIN_SANDBOX_SOURCE_ENV]?.trim();
  if (!source) return null;
  const root = NodePath.resolve(repoRoot, source);
  const manifest = decodeBundle(NodeFS.readFileSync(NodePath.join(root, "runtime.json"), "utf8"));
  if (manifest.nodeArchiveSha256 !== NODE_SANDBOX_ARCHIVES[manifest.arch])
    throw new Error("The sandbox Node archive is not pinned by this host.");
  const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (
    manifest.supervisorSourceSha256 !==
    sha256(NodeFS.readFileSync(NodePath.join(repoRoot, "native/plugin-sandbox/macos.c")))
  )
    throw new Error("The sandbox supervisor source has changed; rebuild the runtime bundle.");
  for (const key of ["bootstrap", "engine", "bridge"] as const) {
    if (manifest.files[key].sha256 !== QUICKJS_RUNTIME_FILES[key].sha256)
      throw new Error("The sandbox interpreter does not match this host profile.");
  }
  for (const pin of Object.values(manifest.files)) {
    const path = NodePath.join(root, pin.name);
    const stat = NodeFS.lstatSync(path);
    if (!stat.isFile() || stat.size > 200 * 1024 * 1024)
      throw new Error("The sandbox bundle contains an invalid file.");
    if (sha256(NodeFS.readFileSync(path)) !== pin.sha256)
      throw new Error("The sandbox bundle does not match its file pins.");
  }
  return { root, manifest };
}

export function snapshotPluginSandboxBundle(
  input: NonNullable<ReturnType<typeof loadPluginSandboxBundleForBuild>>,
  target: string,
) {
  NodeFS.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const pin of Object.values(input.manifest.files)) {
    const bytes = NodeFS.readFileSync(NodePath.join(input.root, pin.name));
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
      throw new Error("The sandbox bundle changed during staging.");
    NodeFS.writeFileSync(NodePath.join(target, pin.name), bytes, { flag: "wx", mode: 0o500 });
  }
  NodeFS.writeFileSync(
    NodePath.join(target, "runtime.json"),
    JSON.stringify(input.manifest) + "\n",
    {
      flag: "wx",
      mode: 0o400,
    },
  );
}
