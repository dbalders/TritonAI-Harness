import { expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  collectProviderUpdateCandidates,
  isProviderUpdateCandidate,
} from "./ProviderUpdateLaunchNotification.logic";
import { getProviderVersionAdvisoryPresentation } from "./settings/providerStatus";

function updateAvailableProvider(input: {
  readonly driver: string;
  readonly canUpdate?: boolean;
  readonly updateCommand?: string | null;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.driver),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-31T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "updateCommand" in input ? input.updateCommand : `update-${input.driver}`,
      canUpdate: input.canUpdate ?? true,
      checkedAt: "2026-08-31T00:00:00.000Z",
      message: "Update available.",
    },
  };
}

it("keeps a manual-only Codex update visible in Settings", () => {
  const codexWithoutUpdateAction = updateAvailableProvider({
    driver: "codex",
    canUpdate: false,
    updateCommand: null,
  });

  expect(collectProviderUpdateCandidates([codexWithoutUpdateAction])).toEqual([
    codexWithoutUpdateAction,
  ]);
});

it("does not surface provider update UI for disabled-check advisory snapshots", () => {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-10T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    // providerMaintenance emits this shape when enableProviderUpdateChecks is false.
    versionAdvisory: {
      status: "unknown",
      currentVersion: "1.0.0",
      latestVersion: null,
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-04-10T00:00:00.000Z",
      message: null,
    },
  };

  expect(isProviderUpdateCandidate(provider)).toBe(false);
  expect(collectProviderUpdateCandidates([provider])).toEqual([]);
  expect(getProviderVersionAdvisoryPresentation(provider.versionAdvisory)).toBeNull();
});
