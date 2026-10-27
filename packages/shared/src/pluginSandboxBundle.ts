import * as Schema from "effect/Schema";
import {
  QUICKJS_EXECUTION_PROFILE,
  QUICKJS_LAUNCHER_NODE_VERSION,
} from "./pluginSandboxProfile.ts";

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const file = <const Name extends string>(name: Name) =>
  Schema.Struct({ name: Schema.Literal(name), sha256: digest });

export const PluginSandboxBundle = Schema.Struct({
  protocol: Schema.Literal("tritonai.plugin-sandbox/v1"),
  executionProfile: Schema.Literal(QUICKJS_EXECUTION_PROFILE),
  platform: Schema.Literal("darwin"),
  arch: Schema.Literals(["arm64", "x64"]),
  nodeVersion: Schema.Literal(QUICKJS_LAUNCHER_NODE_VERSION),
  nodeArchiveSha256: digest,
  supervisorSourceSha256: digest,
  files: Schema.Struct({
    runtime: file("node"),
    supervisor: file("supervisor"),
    bootstrap: file("worker.cjs"),
    engine: file("engine.wasm"),
    bridge: file("guest-bridge.js"),
    nodeLicense: file("LICENSE.node"),
    quickjsLicense: file("LICENSE.quickjs"),
  }),
});
export type PluginSandboxBundle = typeof PluginSandboxBundle.Type;
