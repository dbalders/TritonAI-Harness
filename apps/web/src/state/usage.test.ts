import { USAGE_CONTRACT_VERSION, type EnvironmentId, type UsageSummary } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { selectUsageProvider } from "./usage";

describe("selectUsageProvider", () => {
  it("keeps buckets and source session totals for only the selected provider", () => {
    const summary = {
      contractVersion: USAGE_CONTRACT_VERSION,
      buckets: [
        {
          provider: "codex",
          model: "api-glm-5.2",
          day: "2026-08-31",
          totals: {
            uncachedInputTokens: 40,
            cachedInputTokens: 80,
            cacheCreationTokens: 0,
            outputTokens: 5,
            reasoningTokens: 0,
          },
          costUsd: 0.17,
          cacheSavingsUsd: 0.3,
          costSource: "modelPriced",
          records: 1,
          unpricedRecords: 0,
        },
        {
          provider: "claude",
          model: "claude-opus-test",
          day: "2026-08-31",
          totals: {
            uncachedInputTokens: 987_654,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
          costUsd: 98.76,
          cacheSavingsUsd: 0,
          costSource: "providerReported",
          records: 1,
          unpricedRecords: 0,
        },
      ],
      sources: [
        {
          fingerprint: {
            provider: "codex",
            hostId: "host",
            resolvedHomePath: "/codex",
            volumeId: "1:1",
          },
          status: "ok",
          distinctSessions: 2,
        },
        {
          fingerprint: {
            provider: "claude",
            hostId: "host",
            resolvedHomePath: "/claude",
            volumeId: "1:2",
          },
          status: "ok",
          distinctSessions: 7,
        },
      ],
    } as unknown as UsageSummary;

    const selected = selectUsageProvider(summary, "codex");
    const merged = mergeUsage(
      [
        {
          environmentId: "environment" as EnvironmentId,
          label: "Primary server",
          summary: selected,
        },
      ],
      USAGE_CONTRACT_VERSION,
    );

    expect(selected.buckets.map((bucket) => bucket.provider)).toEqual(["codex"]);
    expect(selected.sources.map((source) => source.fingerprint.provider)).toEqual(["codex"]);
    expect(selected.sources.map((source) => source.distinctSessions)).toEqual([2]);
    expect(merged.totalTokens).toBe(125);
    expect(merged.sessions).toBe(2);
    expect(merged.providers.map((provider) => provider.provider)).toEqual(["codex"]);
    expect(merged.models.map((model) => model.model)).toEqual(["api-glm-5.2"]);
    expect(merged.daily[0]?.totalTokens).toBe(125);
  });
});
