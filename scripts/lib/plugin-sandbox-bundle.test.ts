// @effect-diagnostics nodeBuiltinImport:off -- Build sealing tests read real fixture bytes without executing them.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { type PluginSandboxBundle } from "@t3tools/shared/pluginSandboxBundle";
import { QUICKJS_EXECUTION_PROFILE } from "@t3tools/shared/pluginSandboxProfile";
import {
  loadPluginSandboxBundleForBuild,
  NODE_SANDBOX_ARCHIVES,
  snapshotPluginSandboxBundle,
} from "./plugin-sandbox-bundle.ts";

it("seals runtime staging bytes and rejects changes before the worker can execute", () => {
  const repo = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "plugin-bundle-test-"));
  using _root = { [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }) };
  const source = NodePath.join(root, "source");
  NodeFS.mkdirSync(source);
  const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const pin = <const Name extends string>(name: Name, bytes: Uint8Array) => {
    NodeFS.writeFileSync(NodePath.join(source, name), bytes);
    return { name, sha256: hash(bytes) };
  };
  const native = (name: string) =>
    NodeFS.readFileSync(NodePath.join(repo, "native/plugin-sandbox", name));
  const manifest = {
    protocol: "tritonai.plugin-sandbox/v1",
    executionProfile: QUICKJS_EXECUTION_PROFILE,
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.22.1",
    nodeArchiveSha256: NODE_SANDBOX_ARCHIVES.arm64,
    supervisorSourceSha256: hash(native("macos.c")),
    files: {
      runtime: pin("node", Buffer.from("Fixture runtime, never executed")),
      supervisor: pin("supervisor", Buffer.from("Fixture supervisor, never executed")),
      bootstrap: pin("worker.cjs", native("quickjs-worker.cjs")),
      engine: pin("engine.wasm", native("quickjs/engine.wasm")),
      bridge: pin("guest-bridge.js", native("quickjs/guest-bridge.js")),
      nodeLicense: pin("LICENSE.node", Buffer.from("Fixture license")),
      quickjsLicense: pin("LICENSE.quickjs", native("quickjs/LICENSE")),
    },
  } satisfies PluginSandboxBundle;
  NodeFS.writeFileSync(NodePath.join(source, "runtime.json"), JSON.stringify(manifest));
  const environment = { TRITONAI_PLUGIN_SANDBOX_SOURCE: source };
  const loaded = loadPluginSandboxBundleForBuild(repo, environment)!;
  const target = NodePath.join(root, "snapshot");
  snapshotPluginSandboxBundle(loaded, target);
  expect(NodeFS.readFileSync(NodePath.join(target, "node"), "utf8")).toBe(
    "Fixture runtime, never executed",
  );
  NodeFS.writeFileSync(NodePath.join(source, "node"), "changed");
  expect(() => loadPluginSandboxBundleForBuild(repo, environment)).toThrow("file pins");
  expect(() =>
    snapshotPluginSandboxBundle(loaded, NodePath.join(root, "changed-snapshot")),
  ).toThrow("changed during staging");
});
