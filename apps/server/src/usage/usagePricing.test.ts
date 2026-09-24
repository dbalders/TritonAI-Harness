import { describe, expect, it } from "@effect/vitest";

import {
  cacheSavingsUsd,
  createOverrideRateTable,
  lookupRate,
  parseRateTable,
  priceUsage,
  withTritonAiRates,
} from "./usagePricing.ts";

const rate = (input: number, cacheRead?: number) => ({
  input_cost_per_token: input,
  output_cost_per_token: input * 5,
  ...(cacheRead === undefined ? {} : { cache_read_input_token_cost: cacheRead }),
});

const glm52Totals = {
  uncachedInputTokens: 57_000,
  cachedInputTokens: 263_000,
  cacheCreationTokens: 0,
  outputTokens: 4_540,
  reasoningTokens: 2_490,
};

describe("usage pricing", () => {
  const totals = {
    uncachedInputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 500_000,
  };

  it("uses custom token rates ahead of public and provider-reported costs", () => {
    const table = parseRateTable({ "example-model": rate(1) });
    const overrides = createOverrideRateTable({
      "example-model": {
        inputCostPerMillionTokens: 2,
        outputCostPerMillionTokens: 8,
        cacheReadCostPerMillionTokens: 0.5,
        cacheWriteCostPerMillionTokens: 3,
      },
    });

    for (const reportedCostUsd of [null, 99]) {
      expect(priceUsage(table, "example-model", totals, reportedCostUsd, overrides)).toEqual({
        costUsd: 13.5,
        costSource: "modelPriced",
      });
    }
    expect(cacheSavingsUsd(table, "example-model", totals, overrides)).toBe(1.5);
  });

  it("prices unknown models offline and uses input prices for omitted cache rates", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
    });

    expect(priceUsage(table, "example-model", totals, null, overrides)).toEqual({
      costUsd: 14,
      costSource: "modelPriced",
    });
    expect(cacheSavingsUsd(table, "example-model", totals, overrides)).toBe(0);
  });

  it("preserves explicit zero rates and matches only the exact trimmed model ID", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      " vendor/example-model[1m] ": {
        inputCostPerMillionTokens: 0,
        outputCostPerMillionTokens: 0,
      },
    });
    expect(priceUsage(table, " vendor/example-model[1m] ", totals, 99, overrides)).toEqual({
      costUsd: 0,
      costSource: "modelPriced",
    });
    for (const model of [
      "example-model[1m]",
      "vendor/example-model",
      "vendor/Example-model[1m]",
      "other/example-model[1m]",
    ]) {
      expect(priceUsage(table, model, totals, null, overrides).costSource).toBe("unpriced");
      expect(priceUsage(table, model, totals, 99, overrides)).toEqual({
        costUsd: 99,
        costSource: "providerReported",
      });
    }
  });

  it("keeps the canonical Fable rate separate from DeepInfra in either order", () => {
    const canonical = ["claude-fable-5", rate(1e-5, 1e-6)] as const;
    const deepInfra = ["deepinfra/anthropic/claude-fable-5", rate(1e-5)] as const;

    for (const entries of [
      [canonical, deepInfra],
      [deepInfra, canonical],
    ]) {
      const table = parseRateTable(Object.fromEntries(entries));

      expect(lookupRate(table, "claude-fable-5")?.cacheReadCostPerToken).toBe(1e-6);
      expect(lookupRate(table, "deepinfra/anthropic/claude-fable-5")?.cacheReadCostPerToken).toBe(
        1e-5,
      );
      expect(lookupRate(table, "other/claude-fable-5")).toBeNull();
    }
  });

  it("prices a bracketed context-tier variant at the base model's rate", () => {
    const table = parseRateTable({ "claude-fable-5-1": rate(1e-5, 2.5e-7) });

    expect(lookupRate(table, "claude-fable-5-1[1m]")).toEqual(
      lookupRate(table, "claude-fable-5-1"),
    );
    expect(lookupRate(table, "anthropic/Claude-Fable-5-1[1m]")).toBeNull();
  });

  it("adds a bare alias when every qualified entry has the same rate", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(1),
    });

    expect(lookupRate(table, "example-model")).toEqual(
      lookupRate(table, "provider-a/example-model"),
    );
  });

  it("leaves an ambiguous bare name unpriced", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(3),
    });

    expect(lookupRate(table, "provider-a/example-model")?.inputCostPerToken).toBe(1);
    expect(lookupRate(table, "provider-b/example-model")?.inputCostPerToken).toBe(3);
    expect(lookupRate(table, "example-model")).toBeNull();
  });

  it("prices the TritonAI GLM-5.2 alias from Z.AI's published rates", () => {
    const parsed = parseRateTable({});
    const rates = withTritonAiRates(parsed);

    expect(parsed.size).toBe(0);

    expect(lookupRate(rates, "api-glm-5.2")).toEqual({
      inputCostPerToken: 1.4e-6,
      outputCostPerToken: 4.4e-6,
      cacheReadCostPerToken: 2.6e-7,
      cacheCreationCostPerToken: 0,
    });
    expect(priceUsage(rates, "api-glm-5.2", glm52Totals, null)).toEqual({
      costUsd: expect.closeTo(0.168156, 9),
      costSource: "modelPriced",
    });
    expect(cacheSavingsUsd(rates, "api-glm-5.2", glm52Totals)).toBeCloseTo(0.29982, 9);
  });

  it("prefers LiteLLM's first-party GLM-5.2 row when it becomes available", () => {
    const rates = withTritonAiRates(
      parseRateTable({
        "zai/glm-5.2": {
          input_cost_per_token: 2e-6,
          output_cost_per_token: 6e-6,
          cache_read_input_token_cost: 5e-7,
          cache_creation_input_token_cost: 1e-7,
        },
      }),
    );

    expect(lookupRate(rates, "api-glm-5.2")).toEqual({
      inputCostPerToken: 2e-6,
      outputCostPerToken: 6e-6,
      cacheReadCostPerToken: 5e-7,
      cacheCreationCostPerToken: 1e-7,
    });
  });
});
