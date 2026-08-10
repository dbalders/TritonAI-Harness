import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerPluginInstallResult, ServerPluginsListInput, ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodePluginsListInput = Schema.decodeUnknownSync(ServerPluginsListInput);
const decodePluginInstallResult = Schema.decodeUnknownSync(ServerPluginInstallResult);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });
});

describe("Codex plugin contracts", () => {
  it("defaults remote discovery while accepting an exact plugin allowlist", () => {
    expect(decodePluginsListInput({ pluginIds: ["plugin_asdk_lucid"] })).toEqual({
      includeRemote: true,
      pluginIds: ["plugin_asdk_lucid"],
    });
  });

  it("preserves install-time app authorization metadata", () => {
    const parsed = decodePluginInstallResult({
      plugins: { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] },
      authPolicy: "ON_INSTALL",
      appsNeedingAuth: [
        {
          id: "asdk_app_lucid",
          name: "Lucid",
          installUrl: "https://chatgpt.com/apps/lucid/asdk_app_lucid",
        },
      ],
    });

    expect(parsed.appsNeedingAuth[0]?.name).toBe("Lucid");
    expect(parsed.authPolicy).toBe("ON_INSTALL");
  });
});
