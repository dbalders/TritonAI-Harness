// @effect-diagnostics nodeBuiltinImport:off - Vite config loads this synchronous build input before Effect services exist.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  TRITONAI_IMAGE_CONTEXT_MODEL,
  TritonAiManagedConfig,
  type TritonAiManagedConfig as Config,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const MANAGED_HARNESS_CONFIG_RELATIVE_PATH = "config/tritonai-managed-config.json";

const decodeManagedConfig = Schema.decodeUnknownSync(TritonAiManagedConfig);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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
  for (const route of [config.provider.routes.onPrem, config.provider.routes.frontier]) {
    if (!config.models.catalog.some((model) => model.route === route.id)) {
      throw new Error(
        `Managed Harness config route '${route.id}' must contain at least one model.`,
      );
    }
  }
  for (const model of config.models.catalog) {
    if (
      model.route === config.provider.routes.onPrem.id &&
      model.capabilities?.inputModalities?.includes("text") !== true
    ) {
      throw new Error(
        `Managed on-prem model '${model.id}' must explicitly declare text input support.`,
      );
    }
  }
  const imageContextModel = config.models.catalog.find(
    (model) => model.id === TRITONAI_IMAGE_CONTEXT_MODEL,
  );
  if (imageContextModel?.capabilities?.inputModalities?.includes("image") !== true) {
    throw new Error(
      `Managed image-context model '${TRITONAI_IMAGE_CONTEXT_MODEL}' must explicitly declare image input support.`,
    );
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
