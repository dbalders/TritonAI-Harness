import { assert, it } from "@effect/vitest";

import { createModelCapabilities } from "@t3tools/shared/model";

import {
  appendCustomCodexModels,
  curateVisibleCodexModels,
  mapCodexModelCapabilities,
  tritonAiCodexCapabilities,
} from "./CodexProvider.ts";

it("keeps the key-gated TritonAI models visible with product display names", () => {
  const configuredModels = ["deepseek-v4-flash", "gpt-5.5", "claude-opus-4-8", "gpt-5.4"];
  const reportedModels = appendCustomCodexModels([], configuredModels);
  const models = curateVisibleCodexModels(reportedModels, configuredModels);

  assert.deepStrictEqual(
    curateVisibleCodexModels([], []).map(({ slug }) => slug),
    ["deepseek-v4-flash"],
  );
  assert.deepStrictEqual(
    curateVisibleCodexModels(reportedModels, []).map(({ slug }) => slug),
    ["deepseek-v4-flash"],
  );

  assert.deepStrictEqual(
    models.map(({ slug, name }) => ({ slug, name })),
    [
      { slug: "deepseek-v4-flash", name: "DeepSeek v4 Flash" },
      { slug: "gpt-5.5", name: "GPT-5.5" },
      { slug: "claude-opus-4-8", name: "Claude Opus 4.8" },
    ],
  );
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
