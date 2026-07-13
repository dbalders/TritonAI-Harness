import { assert, it } from "@effect/vitest";

import { DEFAULT_TRITONAI_CODEX_MODEL } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  curateVisibleCodexModels,
  mapCodexModelCapabilities,
  tritonAiCodexCapabilities,
} from "./CodexProvider.ts";

it("applies configured model metadata without model-specific Harness constants", () => {
  const configuredModel = "configured-model";
  const capabilities = tritonAiCodexCapabilities(null);
  const models = curateVisibleCodexModels([], [configuredModel], {
    [configuredModel]: {
      name: "Configured Model",
      shortName: "Configured",
      capabilities,
    },
  });

  assert.deepStrictEqual(
    models.map(({ slug, name, shortName }) => ({ slug, name, shortName })),
    [{ slug: configuredModel, name: "Configured Model", shortName: "Configured" }],
  );
  assert.ok(models.every((model) => model.capabilities?.optionDescriptors?.length));
});

it("uses configured model visibility without a Harness allowlist", () => {
  const configuredModel = "configured-model";
  const models = curateVisibleCodexModels(
    [
      {
        slug: "unconfigured-model",
        name: "Unconfigured",
        isCustom: false,
        capabilities: null,
      },
    ],
    [configuredModel],
    { [configuredModel]: { name: "Configured model", shortName: "Configured" } },
  );

  assert.deepStrictEqual(
    models.map((model) => model.slug),
    [configuredModel],
  );
  assert.strictEqual(models[0]?.capabilities, null);
  assert.strictEqual(models[0]?.name, "Configured model");
  assert.strictEqual(models[0]?.shortName, "Configured");
});

it("falls back to DeepSeek when no models are configured", () => {
  const models = curateVisibleCodexModels([], []);

  assert.deepStrictEqual(
    models.map((model) => model.slug),
    [DEFAULT_TRITONAI_CODEX_MODEL],
  );
});

it("preserves default capabilities when metadata only changes presentation", () => {
  const models = curateVisibleCodexModels([], [DEFAULT_TRITONAI_CODEX_MODEL], {
    [DEFAULT_TRITONAI_CODEX_MODEL]: { name: "Managed DeepSeek" },
  });

  assert.strictEqual(models[0]?.name, "Managed DeepSeek");
  assert.strictEqual(models[0]?.shortName, "DeepSeek");
  assert.ok(models[0]?.capabilities?.optionDescriptors?.length);
});

it("ignores inherited metadata properties", () => {
  const models = curateVisibleCodexModels([], ["constructor"]);

  assert.deepStrictEqual(models, [
    {
      slug: "constructor",
      name: "constructor",
      isCustom: true,
      capabilities: null,
    },
  ]);
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("adds TritonAI reasoning controls to non-reasoning capabilities", () => {
  const capabilities = tritonAiCodexCapabilities(
    createModelCapabilities({
      optionDescriptors: [
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          options: [
            { id: "default", label: "Standard", isDefault: true },
            { id: "fast", label: "Fast" },
          ],
          currentValue: "default",
        },
      ],
    }),
  );

  assert.deepStrictEqual(
    capabilities.optionDescriptors?.map((descriptor) => descriptor.id),
    ["reasoningEffort", "serviceTier"],
  );
});
