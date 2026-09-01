import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import rootRouteSource from "../routes/__root.tsx?raw";
import {
  buildLocalEnvironmentUpdateGroups,
  collectProviderLaunchUpdateCandidates,
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

it("wires the TritonAI launch notification to Codex only", () => {
  const executableRootRouteSource = rootRouteSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  expect(executableRootRouteSource).toContain(
    "<ProviderUpdateLaunchNotification providerDriver={CODEX_PROVIDER_DRIVER} />",
  );
  expect(executableRootRouteSource).toContain('ProviderDriverKind.make("codex")');
});

it("offers the launch popup for Codex updates only", () => {
  const codex = updateAvailableProvider({ driver: "codex" });
  const nonCodexProviders = ["claude", "cursor", "grok", "opencode"].map((driver) =>
    updateAvailableProvider({ driver }),
  );

  expect(
    collectProviderLaunchUpdateCandidates(
      [nonCodexProviders[0]!, codex, ...nonCodexProviders.slice(1)],
      ProviderDriverKind.make("codex"),
    ),
  ).toEqual([codex]);
  expect(
    collectProviderLaunchUpdateCandidates(nonCodexProviders, ProviderDriverKind.make("codex")),
  ).toEqual([]);
});

it("keeps a manual-only Codex update in the launch popup", () => {
  const codexWithoutUpdateAction = updateAvailableProvider({
    driver: "codex",
    canUpdate: false,
    updateCommand: null,
  });

  expect(
    collectProviderLaunchUpdateCandidates(
      [codexWithoutUpdateAction],
      ProviderDriverKind.make("codex"),
    ),
  ).toEqual([codexWithoutUpdateAction]);
  // The broader candidate collector still powers Settings/sidebar visibility.
  expect(collectProviderUpdateCandidates([codexWithoutUpdateAction])).toEqual([
    codexWithoutUpdateAction,
  ]);
});

it("keeps non-Codex providers out of scoped local-environment update rows", () => {
  const codex = updateAvailableProvider({ driver: "codex" });
  const claude = updateAvailableProvider({ driver: "claude" });
  const opencode = updateAvailableProvider({ driver: "opencode" });

  const { groups } = buildLocalEnvironmentUpdateGroups(
    [
      {
        environmentId: EnvironmentId.make("environment-primary"),
        label: "macOS",
        isPrimary: true,
        connectionState: "ready",
        providers: [codex, claude],
      },
      {
        environmentId: EnvironmentId.make("environment-wsl"),
        label: "WSL",
        isPrimary: false,
        connectionState: "ready",
        providers: [opencode],
      },
    ],
    ProviderDriverKind.make("codex"),
  );

  expect(groups[0]?.candidates).toEqual([codex]);
  expect(groups[1]?.candidates).toEqual([]);
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
