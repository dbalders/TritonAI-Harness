import type { ServerPluginSummary, ServerPluginsListResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterPluginListResult } from "./CodexManagement.ts";

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

  it("returns the original result when no allowlist is requested", () => {
    const result: ServerPluginsListResult = {
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    };
    expect(filterPluginListResult(result, undefined)).toBe(result);
  });
});
