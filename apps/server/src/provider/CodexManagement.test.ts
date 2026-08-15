import type { ServerPluginSummary, ServerPluginsListResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterPluginListResult,
  mapPluginInstallResponse,
  pluginIdsForPostInstallRefresh,
} from "./CodexManagement.ts";

const plugin = (overrides: Partial<ServerPluginSummary>): ServerPluginSummary => ({
  id: "local-plugin@local",
  name: "local-plugin",
  enabled: false,
  installed: false,
  authPolicy: "ON_USE",
  installPolicy: "AVAILABLE",
  marketplaceName: "local",
  marketplacePath: "/tmp/marketplace.json",
  source: { type: "local", path: "/tmp/local-plugin" },
  keywords: [],
  ...overrides,
});

describe("filterPluginListResult", () => {
  it("matches exact local or remote IDs and removes empty marketplaces", () => {
    const lucid = plugin({
      id: "lucid@openai-curated-remote",
      name: "lucid",
      marketplaceName: "openai-curated-remote",
      marketplacePath: null,
      remotePluginId: "plugin_asdk_lucid",
      source: { type: "remote" },
    });
    const result: ServerPluginsListResult = {
      marketplaces: [
        { name: "local", path: "/tmp/marketplace.json", plugins: [plugin({})] },
        { name: "openai-curated-remote", plugins: [lucid, plugin({ id: "other@remote" })] },
      ],
      marketplaceLoadErrors: [
        { marketplacePath: "remote plugin catalog", message: "Authentication required." },
      ],
      featuredPluginIds: [lucid.id, "other@remote"],
    };

    expect(filterPluginListResult(result, ["plugin_asdk_lucid"])).toEqual({
      marketplaces: [{ name: "openai-curated-remote", plugins: [lucid] }],
      marketplaceLoadErrors: result.marketplaceLoadErrors,
      featuredPluginIds: [lucid.id],
    });
  });

  it("returns the original result when no response filter is requested", () => {
    const result: ServerPluginsListResult = {
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    };
    expect(filterPluginListResult(result, undefined)).toBe(result);
  });

  it("keeps a local install result when the plugin name differs from its ID", () => {
    const installed = plugin({
      id: "opaque-local-id@local",
      name: "local-plugin",
      installed: true,
    });
    const result: ServerPluginsListResult = {
      marketplaces: [{ name: "local", path: "/tmp/marketplace.json", plugins: [installed] }],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    };
    const pluginIds = pluginIdsForPostInstallRefresh({
      pluginName: installed.name,
      marketplacePath: "/tmp/marketplace.json",
    });

    expect(pluginIds).toBeUndefined();
    expect(filterPluginListResult(result, pluginIds)).toBe(result);
    expect(result.marketplaces[0]?.plugins).toEqual([installed]);
  });

  it("still filters a remote install by its stable remote plugin ID", () => {
    expect(
      pluginIdsForPostInstallRefresh({
        pluginName: "plugin_asdk_lucid",
        remoteMarketplaceName: "openai-curated-remote",
      }),
    ).toEqual(["plugin_asdk_lucid"]);
  });
});

describe("mapPluginInstallResponse", () => {
  it("preserves valid authorization metadata and removes incomplete apps", () => {
    const plugins: ServerPluginsListResult = {
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    };

    expect(
      mapPluginInstallResponse(
        {
          authPolicy: "ON_INSTALL",
          appsNeedingAuth: [
            {
              id: " asdk_app_lucid ",
              name: " Lucid ",
              description: " Diagram with Lucid. ",
              category: " Productivity ",
              installUrl: " https://chatgpt.com/apps/lucid/asdk_app_lucid ",
            },
            { id: "", name: "Missing ID" },
            { id: "missing-name", name: "  " },
          ],
        },
        plugins,
      ),
    ).toEqual({
      plugins,
      authPolicy: "ON_INSTALL",
      appsNeedingAuth: [
        {
          id: "asdk_app_lucid",
          name: "Lucid",
          description: "Diagram with Lucid.",
          category: "Productivity",
          installUrl: "https://chatgpt.com/apps/lucid/asdk_app_lucid",
        },
      ],
    });
  });
});
