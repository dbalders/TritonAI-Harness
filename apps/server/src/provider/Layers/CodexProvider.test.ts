import { assert, it } from "@effect/vitest";

import { DEFAULT_TRITONAI_CODEX_MODEL, TRITONAI_GLM_CODEX_MODEL } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  curateVisibleCodexModels,
  mapCodexModelCapabilities,
  tritonAiCodexCapabilities,
} from "./CodexProvider.ts";

it("exposes DeepSeek and GLM as the TritonAI models", () => {
  const models = curateVisibleCodexModels([]);

  assert.deepStrictEqual(
    models.map(({ slug, name, shortName }) => ({ slug, name, shortName })),
    [
      {
        slug: DEFAULT_TRITONAI_CODEX_MODEL,
        name: "DeepSeek v4 Flash",
        shortName: "DeepSeek",
      },
      { slug: TRITONAI_GLM_CODEX_MODEL, name: "GLM 5.2", shortName: "GLM" },
    ],
  );
  assert.ok(models.every((model) => model.capabilities?.optionDescriptors?.length));
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
