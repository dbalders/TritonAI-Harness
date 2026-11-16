import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { gateDynamicToolCall } from "./CodexDynamicTools.ts";
import { deferredPluginTool, makeCodexFlatToolCatalog } from "./CodexFlatTools.ts";
import { makePluginToolBrowser } from "./CodexPluginToolDiscovery.ts";

const plugins = vi.hoisted(() => ({ draftsEnabled: false }));

vi.mock("../integrations/IntegrationRegistry.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../integrations/IntegrationRegistry.ts")>()),
  getIntegrationRegistryOptional: () => ({
    prepareSkillRuntime: async () => null,
    toolDefinitions: () => [
      {
        name: "microsoft365.mail.draft.reply",
        description: "Create one unsent reply draft.",
        input: Schema.Struct({ messageId: Schema.String, body: Schema.String }),
        readOnly: false,
        openWorld: true,
      },
    ],
    isToolAvailableSync: () => plugins.draftsEnabled,
    toolAvailabilitySync: () =>
      plugins.draftsEnabled
        ? { available: true }
        : {
            available: false,
            reason: "capability_not_selected",
            detail: "the Create mail drafts capability is not enabled.",
          },
    toolRequiresApprovalSync: () => true,
  }),
}));

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
    for (const namespace of ["", "  "])
      expect(browser.browse({ namespace, offset: 0 })).toEqual({
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

describe("deferred plugin catalog", () => {
  const threadId = ThreadId.make("deferred-write-thread");
  const instanceId = ProviderInstanceId.make("codex");

  it.effect("keeps a disabled write in the thread so enabling it later works", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("environment:deferred-write"),
        threadId,
        providerSessionId: "mcp:deferred-write",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer thread-credential",
        browserToolsAvailable: false,
        capabilities: new Set(["integrations.invoke"]),
      });
      plugins.draftsEnabled = false;
      const catalog = yield* makeCodexFlatToolCatalog({
        threadId,
        instanceId,
        deferPluginTools: true,
      });
      const payload = { tool: "microsoft365_mail_draft_reply", namespace: "microsoft365" };

      const refused = yield* gateDynamicToolCall({ options: catalog.options, payload });
      assert.isFalse(refused.allowed);
      if (!refused.allowed)
        expect(JSON.stringify(refused.response)).toContain(
          "Create mail drafts capability is not enabled",
        );

      plugins.draftsEnabled = true;
      const admitted = yield* gateDynamicToolCall({ options: catalog.options, payload });
      assert.isTrue(admitted.allowed);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpProviderSessions.layer,
          NodeServices.layer,
          ServerConfig.layerTest(process.cwd(), { prefix: "codex-flat-tools-test-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );
});
