// @effect-diagnostics nodeBuiltinImport:off - Vite config loads this synchronous build input before Effect services exist.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { TritonAiManagedConfig, type TritonAiManagedConfig as Config } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const MANAGED_HARNESS_CONFIG_RELATIVE_PATH = "config/tritonai-managed-config.json";

const decodeManagedConfig = Schema.decodeUnknownSync(TritonAiManagedConfig);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

export interface ManagedHarnessConfigBuildInput {
  readonly config: Config;
  readonly digest: string;
  readonly source: string;
  readonly sourcePath: string;
}

export function parseManagedHarnessConfig(source: string): Config {
  const json = decodeUnknownJson(source);
  const config = decodeManagedConfig(json, { onExcessProperty: "error" });
  const modelIds = new Set(config.models.catalog.map((model) => model.id));
  if (!modelIds.has(config.models.default)) {
    throw new Error("Managed Harness config catalog must contain the default model.");
  }
  if (!modelIds.has(config.models.restrictedFallback)) {
    throw new Error("Managed Harness config catalog must contain the restricted fallback model.");
  }
  for (const replacement of Object.values(config.models.replacements)) {
    if (!modelIds.has(replacement)) {
      throw new Error(`Managed Harness config replacement '${replacement}' is not in the catalog.`);
    }
  }
  return config;
}

export function loadManagedHarnessConfigForBuild(repoRoot: string): ManagedHarnessConfigBuildInput {
  const sourcePath = NodePath.join(repoRoot, MANAGED_HARNESS_CONFIG_RELATIVE_PATH);
  let source: string;
  try {
    source = NodeFS.readFileSync(sourcePath, "utf8");
  } catch (cause) {
    throw new Error(`Required managed Harness config is missing at ${sourcePath}.`, { cause });
  }
  const config = parseManagedHarnessConfig(source);
  return {
    config,
    digest: NodeCrypto.createHash("sha256").update(source).digest("hex"),
    source,
    sourcePath,
  };
}
