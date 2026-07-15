import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildTritonAiCodexModelCatalog,
  managedCodexModelCatalogFileName,
} from "./CodexModelCatalog.ts";

const bundledCatalog = JSON.stringify({
  models: [
    {
      slug: "gpt-5.2",
      display_name: "GPT-5.2",
      description: "Bundled model",
      priority: 29,
      visibility: "list",
      base_instructions: "You are GPT-5.2.",
      model_messages: { instructions_template: "Use GPT-5.2 instructions." },
      input_modalities: ["text", "image"],
      context_window: 123_000,
      max_context_window: 124_000,
      truncation_policy: { mode: "tokens", limit: 12_345 },
      use_responses_lite: false,
    },
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      priority: 7,
      input_modalities: ["text", "image"],
    },
  ],
});

describe("CodexModelCatalog", () => {
  it("uses distinct catalog files for distinct provider instances", () => {
    NodeAssert.notEqual(
      managedCodexModelCatalogFileName("codex"),
      managedCodexModelCatalogFileName("codex-work"),
    );
  });

  it("adds only custom models with explicit input modality metadata", () => {
    const result = JSON.parse(
      buildTritonAiCodexModelCatalog(bundledCatalog, {
        "api-glm-5.2": {
          name: "GLM 5.2",
          capabilities: { inputModalities: ["text"] },
        },
        "api-gemma-4-31b": {
          name: "Gemma 4 31B",
          capabilities: { inputModalities: ["text", "image"] },
        },
        "custom-with-unknown-modalities": { name: "Unknown" },
      }),
    ) as { models: Array<Record<string, unknown>> };

    NodeAssert.deepStrictEqual(
      result.models.map((model) => model.slug),
      ["gpt-5.2", "gpt-5.5", "api-glm-5.2", "api-gemma-4-31b"],
    );
    const glm = result.models.find((model) => model.slug === "api-glm-5.2");
    NodeAssert.deepStrictEqual(glm?.input_modalities, ["text"]);
    NodeAssert.equal(glm?.visibility, "hide");
    NodeAssert.equal(glm?.base_instructions, "You are GPT-5.2.");
    NodeAssert.equal(glm?.default_reasoning_level, null);
    NodeAssert.deepStrictEqual(glm?.supported_reasoning_levels, []);
    NodeAssert.equal(glm?.shell_type, "default");
    NodeAssert.equal(glm?.support_verbosity, false);
    NodeAssert.equal(glm?.apply_patch_tool_type, null);
    NodeAssert.equal(glm?.supports_parallel_tool_calls, false);
    NodeAssert.equal(glm?.model_messages, null);
    NodeAssert.equal(glm?.context_window, 123_000);
    NodeAssert.equal(glm?.max_context_window, 124_000);
    NodeAssert.deepStrictEqual(glm?.truncation_policy, { mode: "tokens", limit: 12_345 });

    const gemma = result.models.find((model) => model.slug === "api-gemma-4-31b");
    NodeAssert.deepStrictEqual(gemma?.input_modalities, ["text", "image"]);
  });

  it("updates explicit modalities for a model already in the bundled catalog", () => {
    const result = JSON.parse(
      buildTritonAiCodexModelCatalog(bundledCatalog, {
        "gpt-5.5": {
          name: "Managed GPT-5.5",
          capabilities: { inputModalities: ["text"] },
        },
      }),
    ) as { models: Array<Record<string, unknown>> };

    const model = result.models.find((entry) => entry.slug === "gpt-5.5");
    NodeAssert.equal(model?.display_name, "Managed GPT-5.5");
    NodeAssert.deepStrictEqual(model?.input_modalities, ["text"]);
  });

  it("rejects malformed bundled catalog output", () => {
    NodeAssert.throws(
      () => buildTritonAiCodexModelCatalog("{}", {}),
      /did not contain a models array/,
    );
  });
});
