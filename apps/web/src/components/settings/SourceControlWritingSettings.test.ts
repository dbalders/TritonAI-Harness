import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterSupportedSourceControlWriterProviders } from "./SourceControlWritingSettings";

function provider(instanceId: string, driver: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-27T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("source control writer provider policy", () => {
  it("keeps every TritonAI Codex instance and drops legacy upstream drivers", () => {
    const providers = [
      provider("codex", "codex"),
      provider("codex_work", "codex"),
      provider("claude", "claudeAgent"),
      provider("cursor", "cursor"),
      provider("legacy", "legacy-upstream"),
    ];

    expect(
      filterSupportedSourceControlWriterProviders(providers).map(
        (candidate) => candidate.instanceId,
      ),
    ).toEqual([ProviderInstanceId.make("codex"), ProviderInstanceId.make("codex_work")]);
  });
});
