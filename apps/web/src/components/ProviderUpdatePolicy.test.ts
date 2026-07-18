import { expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import rootRouteSource from "../routes/__root.tsx?raw";
import {
  collectProviderUpdateCandidates,
  isProviderUpdateCandidate,
} from "./ProviderUpdateLaunchNotification.logic";
import { getProviderVersionAdvisoryPresentation } from "./settings/providerStatus";

it("does not reference provider update launch notifications in the TritonAI root", () => {
  const executableRootRouteSource = rootRouteSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  expect(executableRootRouteSource).not.toContain("ProviderUpdateLaunchNotification");
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
