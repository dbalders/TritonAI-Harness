import type { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ProcessRunner from "../../processRunner.ts";

const MANAGED_MODEL_CATALOG_FILE = "tritonai-model-catalog.json";
const MODEL_TEMPLATE_SLUG = "gpt-5.2";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function managedCodexModelCatalogFileName(catalogKey: string): string {
  const catalogSuffix = Buffer.from(catalogKey, "utf8").toString("base64url");
  return MANAGED_MODEL_CATALOG_FILE.replace(".json", `-${catalogSuffix}.json`);
}

function explicitInputModalities(
  metadata: CodexSettings["customModelMetadata"][string],
): ReadonlyArray<"text" | "image"> | undefined {
  const modalities = metadata.capabilities?.inputModalities;
  return modalities && modalities.length > 0 ? modalities : undefined;
}

function managedModelFromTemplate(input: {
  readonly template: JsonObject;
  readonly slug: string;
  readonly name: string;
  readonly inputModalities: ReadonlyArray<"text" | "image">;
  readonly priority: number;
}): JsonObject {
  return {
    ...input.template,
    slug: input.slug,
    display_name: input.name,
    description: `${input.name} routed through TritonAI.`,
    visibility: "hide",
    priority: input.priority,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: "default",
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    model_messages: null,
    include_skills_usage_instructions: false,
    supports_reasoning_summaries: true,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: [...input.inputModalities],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: null,
    tool_mode: null,
    multi_agent_version: null,
  };
}

export function buildTritonAiCodexModelCatalog(
  bundledCatalogJson: string,
  customModelMetadata: CodexSettings["customModelMetadata"],
): string {
  const parsed: unknown = JSON.parse(bundledCatalogJson);
  if (!isJsonObject(parsed) || !Array.isArray(parsed.models)) {
    throw new Error("Codex bundled model catalog did not contain a models array.");
  }

  const models = parsed.models.filter(isJsonObject);
  const template =
    models.find((model) => model.slug === MODEL_TEMPLATE_SLUG) ??
    models.find((model) => model.tool_mode == null && model.use_responses_lite === false) ??
    models[0];
  if (!template) {
    throw new Error("Codex bundled model catalog did not contain a reusable model entry.");
  }

  const managedEntries = Object.entries(customModelMetadata).filter(
    (entry): entry is [string, CodexSettings["customModelMetadata"][string]] =>
      explicitInputModalities(entry[1]) !== undefined,
  );
  const managedBySlug = new Map(managedEntries);
  const existingSlugs = new Set<string>();
  const mergedModels = models.map((model) => {
    const slug = typeof model.slug === "string" ? model.slug : undefined;
    if (!slug) return model;
    existingSlugs.add(slug);
    const metadata = managedBySlug.get(slug);
    const inputModalities = metadata ? explicitInputModalities(metadata) : undefined;
    return metadata && inputModalities
      ? {
          ...model,
          display_name: metadata.name,
          input_modalities: [...inputModalities],
        }
      : model;
  });

  let priority =
    Math.max(
      0,
      ...models.map((model) => (typeof model.priority === "number" ? model.priority : 0)),
    ) + 1;
  for (const [slug, metadata] of managedEntries) {
    if (existingSlugs.has(slug)) continue;
    const inputModalities = explicitInputModalities(metadata);
    if (!inputModalities) continue;
    mergedModels.push(
      managedModelFromTemplate({
        template,
        slug,
        name: metadata.name,
        inputModalities,
        priority,
      }),
    );
    priority += 1;
  }

  return `${JSON.stringify({ ...parsed, models: mergedModels }, null, 2)}\n`;
}

export class CodexModelCatalogError extends Schema.TaggedErrorClass<CodexModelCatalogError>()(
  "CodexModelCatalogError",
  {
    operation: Schema.Literals(["readBundledCatalog", "buildCatalog", "writeCatalog"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation}: ${this.detail}`;
  }
}

export const materializeTritonAiCodexModelCatalog = Effect.fn(
  "materializeTritonAiCodexModelCatalog",
)(function* (input: {
  readonly binaryPath: string;
  readonly homePath: string;
  readonly catalogKey: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly customModelMetadata: CodexSettings["customModelMetadata"];
}) {
  const hasExplicitModalities = Object.values(input.customModelMetadata).some(
    (metadata) => explicitInputModalities(metadata) !== undefined,
  );
  if (!hasExplicitModalities) return undefined;

  const processRunner = yield* ProcessRunner.ProcessRunner;
  const path = yield* Path.Path;
  const output = yield* processRunner
    .run({
      command: input.binaryPath,
      args: ["debug", "models", "--bundled"],
      env: input.environment,
      maxOutputBytes: 16 * 1024 * 1024,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new CodexModelCatalogError({
            operation: "readBundledCatalog",
            detail: cause.message,
            cause,
          }),
      ),
    );
  if (output.code !== 0) {
    return yield* new CodexModelCatalogError({
      operation: "readBundledCatalog",
      detail: output.stderr.trim() || `Codex exited with code ${String(output.code)}.`,
    });
  }

  const contents = yield* Effect.try({
    try: () => buildTritonAiCodexModelCatalog(output.stdout, input.customModelMetadata),
    catch: (cause) =>
      new CodexModelCatalogError({
        operation: "buildCatalog",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
  const filePath = path.join(input.homePath, managedCodexModelCatalogFileName(input.catalogKey));
  yield* writeFileStringAtomically({ filePath, contents }).pipe(
    Effect.mapError(
      (cause) =>
        new CodexModelCatalogError({
          operation: "writeCatalog",
          detail: cause.message,
          cause,
        }),
    ),
  );
  return filePath;
});
