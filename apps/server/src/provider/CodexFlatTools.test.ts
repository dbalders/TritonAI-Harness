import { assert, describe, expect, it } from "@effect/vitest";
import { deferredPluginTool } from "./CodexFlatTools.ts";
import { makePluginToolBrowser } from "./CodexPluginToolDiscovery.ts";

describe("deferredPluginTool", () => {
  it("groups a plugin tool under its plugin so Codex tool search can defer it", () => {
    assert.deepEqual(deferredPluginTool("microsoft365.mail.search", true), {
      namespace: "microsoft365",
      deferLoading: true,
    });
    assert.deepEqual(deferredPluginTool("kuali-build.forms.list", true), {
      namespace: "kuali-build",
      deferLoading: true,
    });
  });

  it("keeps tools direct when deferral is off or the namespace is unusable", () => {
    assert.deepEqual(deferredPluginTool("microsoft365.mail.search", false), {});
    // Codex rejects the whole thread if any dynamic tool uses a reserved namespace.
    for (const name of [
      "functions.run",
      "tool_search.x",
      "web.fetch",
      "terminal.read",
      "browser.open",
      "python.run",
      "mcp.call",
      "mcp__x.y",
      ".bare",
    ])
      assert.deepEqual(deferredPluginTool(name, true), {}, name);
    assert.deepEqual(deferredPluginTool(`${"a".repeat(65)}.tool`, true), {});
  });
});

describe("plugin operation browsing", () => {
  it("pages only disclosed deferred names without exposing their schemas", () => {
    const browser = makePluginToolBrowser([
      ...Array.from({ length: 33 }, (_, index) => ({
        name: `github_repositories_${String(index).padStart(2, "0")}`,
        description: "List\n repositories for this account.",
        namespace: "github",
        deferLoading: true,
        inputSchema: { privateSchemaField: "must stay outside discovery output" },
      })),
      {
        name: "lucid_search_documents",
        description: "Search documents.",
        namespace: "lucid",
        deferLoading: true,
      },
      { name: "direct_tool", description: "Direct tool." },
    ]);
    assert.deepEqual(browser.browse({}), {
      entries: [{ namespace: "github" }, { namespace: "lucid" }],
      total: 2,
      nextOffset: null,
    });
    const first = browser.browse({ namespace: "github" });
    assert.equal(first.entries.length, 32);
    assert.equal(first.nextOffset, 32);
    expect(first.entries[0]).toEqual({
      namespace: "github",
      name: "github_repositories_00",
      description: "List repositories for this account.",
    });
    expect(browser.browse({ namespace: "github", offset: 32 })).toEqual({
      entries: [
        {
          namespace: "github",
          name: "github_repositories_32",
          description: "List repositories for this account.",
        },
      ],
      total: 33,
      nextOffset: null,
    });
    assert.throws(() => browser.browse({ namespace: "github", offset: -1 }));
  });
});
