// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- This standalone build step downloads and seals a checksum-pinned distribution archive.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { PluginSandboxBundle } from "@t3tools/shared/pluginSandboxBundle";
import {
  QUICKJS_EXECUTION_PROFILE,
  QUICKJS_LAUNCHER_NODE_VERSION,
} from "@t3tools/shared/pluginSandboxProfile";
import {
  loadPluginSandboxBundleForBuild,
  NODE_SANDBOX_ARCHIVES,
} from "./lib/plugin-sandbox-bundle.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const host = Effect.runSync(
  Effect.all({ platform: HostProcess.Platform, arch: HostProcess.Architecture }),
);
const [destination, requestedArch = host.arch] = process.argv.slice(2);
if (
  !destination ||
  host.platform !== "darwin" ||
  (requestedArch !== "arm64" && requestedArch !== "x64")
)
  throw new Error("Supply a new destination directory and arm64 or x64 on a macOS build host.");
const arch = requestedArch;
const target = NodePath.resolve(destination);
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const temporary = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "plugin-sandbox-build-"));
let created = false;
try {
  await NodeFSP.mkdir(target, { mode: 0o700 });
  created = true;
  const stem = `node-v${QUICKJS_LAUNCHER_NODE_VERSION}-darwin-${arch}`;
  const response = await fetch(
    `https://nodejs.org/dist/v${QUICKJS_LAUNCHER_NODE_VERSION}/${stem}.tar.gz`,
  );
  if (!response.ok) throw new Error("The pinned Node runtime archive could not be downloaded.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 200 * 1024 * 1024 || sha256(bytes) !== NODE_SANDBOX_ARCHIVES[arch])
    throw new Error("The Node runtime archive does not match the reviewed pin.");
  const archive = NodePath.join(temporary, "node.tar.gz");
  await NodeFSP.writeFile(archive, bytes);
  await execute("/usr/bin/tar", [
    "-xzf",
    archive,
    "-C",
    temporary,
    `${stem}/bin/node`,
    `${stem}/LICENSE`,
  ]);
  await NodeFSP.copyFile(NodePath.join(temporary, stem, "bin/node"), NodePath.join(target, "node"));
  await NodeFSP.copyFile(
    NodePath.join(temporary, stem, "LICENSE"),
    NodePath.join(target, "LICENSE.node"),
  );
  const native = NodePath.join(repoRoot, "native/plugin-sandbox");
  const supervisorSource = NodePath.join(native, "macos.c");
  await execute("xcrun", [
    "clang",
    "-arch",
    arch === "x64" ? "x86_64" : "arm64",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    supervisorSource,
    "-lsandbox",
    "-o",
    NodePath.join(target, "supervisor"),
  ]);
  for (const [source, name] of [
    ["quickjs-worker.cjs", "worker.cjs"],
    ["quickjs/engine.wasm", "engine.wasm"],
    ["quickjs/guest-bridge.js", "guest-bridge.js"],
    ["quickjs/LICENSE", "LICENSE.quickjs"],
  ] as const)
    await NodeFSP.copyFile(NodePath.join(native, source), NodePath.join(target, name));
  const pin = async (name: string) => ({
    name,
    sha256: sha256(await NodeFSP.readFile(NodePath.join(target, name))),
  });
  const manifest = Schema.decodeUnknownSync(PluginSandboxBundle)({
    protocol: "tritonai.plugin-sandbox/v1",
    executionProfile: QUICKJS_EXECUTION_PROFILE,
    platform: "darwin",
    arch,
    nodeVersion: QUICKJS_LAUNCHER_NODE_VERSION,
    nodeArchiveSha256: NODE_SANDBOX_ARCHIVES[arch],
    supervisorSourceSha256: sha256(await NodeFSP.readFile(supervisorSource)),
    files: {
      runtime: await pin("node"),
      supervisor: await pin("supervisor"),
      bootstrap: await pin("worker.cjs"),
      engine: await pin("engine.wasm"),
      bridge: await pin("guest-bridge.js"),
      nodeLicense: await pin("LICENSE.node"),
      quickjsLicense: await pin("LICENSE.quickjs"),
    },
  });
  await NodeFSP.chmod(NodePath.join(target, "node"), 0o500);
  await NodeFSP.chmod(NodePath.join(target, "supervisor"), 0o500);
  await NodeFSP.writeFile(NodePath.join(target, "runtime.json"), JSON.stringify(manifest) + "\n", {
    mode: 0o400,
    flag: "wx",
  });
  loadPluginSandboxBundleForBuild(repoRoot, { TRITONAI_PLUGIN_SANDBOX_SOURCE: target });
  process.stdout.write(JSON.stringify({ directory: target, manifest }) + "\n");
} catch (error) {
  if (created) await NodeFSP.rm(target, { recursive: true, force: true });
  throw error;
} finally {
  await NodeFSP.rm(temporary, { recursive: true, force: true });
}
