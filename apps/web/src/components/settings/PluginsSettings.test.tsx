import type {
  IntegrationConnectResult,
  IntegrationSummary,
  ServerPluginSummary,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  IntegrationConnectionActionCallout,
  IntegrationAuthorizationFlow,
  LUCID_APP_ID,
  LUCID_AUTH_URL,
  LUCID_REMOTE_PLUGIN_ID,
  LucidCodexPluginCard,
  WRITE_TOOL_ACCESS_ARIA_LABEL,
  WRITE_TOOL_ACCESS_LABEL,
  capabilityAccessStateLabel,
  capabilityUsesWriteTool,
  clearOwnedConnectionAttention,
  integrationConnectAriaLabel,
  integrationNeedsConnectionAction,
  reconcileConnectionAttentionForIntegration,
  findLucidPlugin,
  lucidPluginNeedsAuthorization,
  lucidPluginUninstallInput,
  readLucidAuthHandoff,
  remotePluginCatalogError,
  safeLucidAuthUrl,
  shouldExpandIntegrationCard,
  shouldFocusConnectionAction,
  writeLucidAuthHandoff,
} from "./PluginsSettings.tsx";

const lucidPlugin = (overrides: Partial<ServerPluginSummary> = {}): ServerPluginSummary => ({
  id: "app-69c597eebdd4819194fd9c4d03acedb6@openai-curated-remote",
  name: "app-69c597eebdd4819194fd9c4d03acedb6",
  displayName: "Lucid",
  description: "Ideate, diagram, and align teams.",
  developerName: "Lucid Software",
  enabled: false,
  installed: false,
  authPolicy: "ON_INSTALL",
  installPolicy: "AVAILABLE",
  availability: "AVAILABLE",
  remotePluginId: LUCID_REMOTE_PLUGIN_ID,
  marketplaceName: "openai-curated-remote",
  source: { type: "remote" },
  keywords: [],
  ...overrides,
});

const summary = (overrides: Partial<IntegrationSummary> = {}): IntegrationSummary => ({
  id: "microsoft-365-read",
  name: "Microsoft 365 Read",
  description: "Reads Microsoft 365 data.",
  version: "1.0.0",
  apiVersion: "tritonai.harness/v2",
  installed: true,
  enabled: true,
  requiresConnection: true,
  connectionState: "not_connected",
  accountLabel: null,
  statusMessage: null,
  capabilities: [
    {
      id: "mail.read",
      displayName: "Read mail",
      description: "Read mail.",
      access: "default",
      enabled: true,
      granted: false,
      available: false,
    },
  ],
  tools: [],
  skills: [],
  ...overrides,
});

describe("PluginsSettings connection action", () => {
  it("renders a device code with exact-value selection and copy affordances", () => {
    const flow = {
      kind: "device_code",
      flowId: "flow-device",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: null,
      userCode: "ABCD-EFGH",
      message: "Enter the code in GitHub.",
      expiresAt: "2030-01-01T00:00:00.000Z",
      intervalSeconds: 5,
    } satisfies IntegrationConnectResult;
    const markup = renderToStaticMarkup(
      <IntegrationAuthorizationFlow
        integrationName="GitHub"
        flow={flow}
        busy={false}
        onApiKeySubmit={async () => undefined}
      />,
    );
    expect(markup).toContain("ABCD-EFGH");
    expect(markup).toContain("select-all");
    expect(markup).toContain("Copy code");
    expect(markup).toContain('href="https://github.com/login/device"');
  });

  it("renders a native-browser flow as a system-browser sign-in link without a code field", () => {
    const flow = {
      kind: "authorization_url",
      flowId: "flow-1",
      authorizationUrl: "https://accounts.example.test/authorize?state=opaque",
      message: "Continue in your system browser.",
      expiresAt: "2030-01-01T00:00:00.000Z",
      intervalSeconds: 2,
    } satisfies IntegrationConnectResult;
    const markup = renderToStaticMarkup(
      <IntegrationAuthorizationFlow
        integrationName="Google Workspace"
        flow={flow}
        busy={false}
        onApiKeySubmit={async () => undefined}
      />,
    );
    expect(markup).toContain("Finish signing in to Google Workspace");
    expect(markup).toContain('href="https://accounts.example.test/authorize?state=opaque"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain("Open sign-in");
    expect(markup).not.toContain("userCode");
  });

  it("persists and expands the enabled-but-unconnected action state", () => {
    expect(integrationNeedsConnectionAction(summary())).toBe(true);
    expect(integrationNeedsConnectionAction(summary({ connectionState: "error" }))).toBe(true);
    expect(shouldExpandIntegrationCard({ needsConnectionAction: true, hasFlow: false })).toBe(true);
  });

  it("auto-expands and focuses after a successful install or enable attention request", () => {
    expect(
      shouldExpandIntegrationCard({
        needsConnectionAction: true,
        hasFlow: false,
        connectionAttentionRequest: 1,
      }),
    ).toBe(true);
    expect(shouldFocusConnectionAction({ expanded: true, connectionAttentionRequest: 1 })).toBe(
      true,
    );
    expect(
      shouldFocusConnectionAction({
        expanded: true,
        connectionAttentionRequest: 1,
        handledAttentionRequest: 1,
      }),
    ).toBe(false);
    expect(
      shouldFocusConnectionAction({
        expanded: true,
        connectionAttentionRequest: 2,
        handledAttentionRequest: 1,
      }),
    ).toBe(true);
  });

  it("does not require or force connection for exceptions", () => {
    expect(integrationNeedsConnectionAction(summary({ requiresConnection: false }))).toBe(false);
    expect(integrationNeedsConnectionAction(summary({ connectionState: "connected" }))).toBe(true);
    expect(
      integrationNeedsConnectionAction(
        summary({
          connectionState: "connected",
          capabilities: summary().capabilities.map((capability) => ({
            ...capability,
            granted: true,
            available: true,
          })),
        }),
      ),
    ).toBe(false);
    expect(integrationNeedsConnectionAction(summary({ enabled: false }))).toBe(false);
    expect(integrationNeedsConnectionAction(summary({ installed: false }))).toBe(false);
    expect(
      integrationNeedsConnectionAction(
        summary({
          capabilities: summary().capabilities.map((capability) => ({
            ...capability,
            enabled: false,
          })),
        }),
      ),
    ).toBe(false);
    expect(shouldExpandIntegrationCard({ needsConnectionAction: false, hasFlow: false })).toBe(
      false,
    );
  });

  it("uses a non-color-only live callout and explicit accessible Connect label", () => {
    const markup = renderToStaticMarkup(
      <IntegrationConnectionActionCallout integrationName="Microsoft 365 Read" />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Action required: Connect Microsoft 365 Read");
    expect(integrationConnectAriaLabel("Microsoft 365 Read")).toBe("Connect Microsoft 365 Read");
  });

  it("preserves another plugin's pending connection announcement", () => {
    const current = {
      attention: { id: "plugin-b", request: 2 },
      announcement: "Action required: Connect Plugin B",
    };
    expect(clearOwnedConnectionAttention(current, "plugin-a")).toBe(current);
    expect(clearOwnedConnectionAttention(current, "plugin-b")).toEqual({
      attention: null,
      announcement: "",
    });
  });

  it("clears owned connection attention when a capability update resolves it", () => {
    const integration = summary();
    const current = {
      attention: { id: integration.id, request: 2 },
      announcement: `Action required: Connect ${integration.name}`,
    };
    expect(
      reconcileConnectionAttentionForIntegration(current, integration.id, {
        ...integration,
        capabilities: integration.capabilities.map((capability) => ({
          ...capability,
          enabled: false,
        })),
      }),
    ).toEqual({ attention: null, announcement: "" });
    expect(reconcileConnectionAttentionForIntegration(current, integration.id, integration)).toBe(
      current,
    );
  });
});

describe("Lucid hosted Codex plugin", () => {
  it("selects only Lucid by its stable remote plugin ID", () => {
    const plugin = lucidPlugin();
    expect(
      findLucidPlugin({
        marketplaces: [
          {
            name: "openai-curated-remote",
            plugins: [lucidPlugin({ remotePluginId: "plugin_asdk_unrelated" }), plugin],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      }),
    ).toBe(plugin);
  });

  it("accepts only Lucid's exact ChatGPT authorization URL", () => {
    expect(safeLucidAuthUrl(LUCID_AUTH_URL)).toBe(LUCID_AUTH_URL);
    expect(safeLucidAuthUrl(`https://chatgpt.com/apps/lucid/${LUCID_APP_ID}?continue=true`)).toBe(
      `${LUCID_AUTH_URL}?continue=true`,
    );
    expect(safeLucidAuthUrl("https://evil.example/apps/lucid/fake")).toBe(LUCID_AUTH_URL);
    expect(safeLucidAuthUrl("not a url")).toBe(LUCID_AUTH_URL);
  });

  it("recovers the sign-in action from an installed ON_INSTALL catalog entry", () => {
    expect(lucidPluginNeedsAuthorization(lucidPlugin({ installed: true }))).toBe(true);
    expect(
      lucidPluginNeedsAuthorization(lucidPlugin({ installed: true, authPolicy: "ON_USE" })),
    ).toBe(false);
    expect(lucidPluginNeedsAuthorization(undefined)).toBe(false);
  });

  it("preserves a validated sign-in handoff across a Plugins screen remount", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const authUrl = `${LUCID_AUTH_URL}?continue=true`;

    writeLucidAuthHandoff(storage, "local", { attention: true, authUrl });

    expect(readLucidAuthHandoff(storage, "local")).toEqual({ attention: true, authUrl });
    writeLucidAuthHandoff(storage, "local", null);
    expect(readLucidAuthHandoff(storage, "local")).toBeNull();
  });

  it("uninstalls Lucid with its installed catalog ID instead of its remote ID", () => {
    const plugin = lucidPlugin();
    expect(plugin.id).not.toBe(LUCID_REMOTE_PLUGIN_ID);
    expect(lucidPluginUninstallInput(plugin)).toEqual({ pluginId: plugin.id });
  });

  it("keeps remote catalog errors visible after mutations", () => {
    expect(
      remotePluginCatalogError({
        marketplaces: [],
        marketplaceLoadErrors: [
          { marketplacePath: "local", message: "Local warning" },
          { marketplacePath: "remote plugin catalog", message: "Authentication required." },
        ],
        featuredPluginIds: [],
      }),
    ).toBe("Authentication required.");
  });

  it("renders a reversible install toggle and the OAuth handoff after installation", () => {
    const markup = renderToStaticMarkup(
      <LucidCodexPluginCard
        plugin={lucidPlugin({ installed: true, enabled: true })}
        busy={false}
        authAttention={true}
        authUrl={LUCID_AUTH_URL}
        onToggle={() => undefined}
      />,
    );

    expect(markup).toContain("Lucid Software");
    expect(markup).toContain("Action required: Connect Lucid");
    expect(markup).toContain("Finish sign-in");
    expect(markup).toContain(`href="${LUCID_AUTH_URL}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('aria-label="Disable Lucid"');
  });

  it("allows an installed Lucid plugin to be removed after an admin policy change", () => {
    const markup = renderToStaticMarkup(
      <LucidCodexPluginCard
        plugin={lucidPlugin({
          installed: true,
          enabled: true,
          availability: "DISABLED_BY_ADMIN",
        })}
        busy={false}
        authAttention={false}
        authUrl={LUCID_AUTH_URL}
        onToggle={() => undefined}
      />,
    );

    expect(markup).toContain("Installed copies can still be removed.");
    expect(markup).toContain('aria-label="Disable Lucid"');
    expect(markup).not.toContain('aria-label="Disable Lucid" disabled');
  });
});

describe("PluginsSettings capability access", () => {
  const capability = {
    id: "mail.draft.create",
    displayName: "Create mail drafts",
    description: "Create drafts without sending them.",
    access: "opt-in" as const,
    enabled: false,
    granted: true,
    available: false,
  };
  const integration = summary({
    connectionState: "connected",
    capabilities: [capability],
    tools: [
      {
        name: "microsoft365.mail.draft.create",
        displayName: "Create draft",
        description: "Create a draft without sending.",
        capabilities: [capability.id],
        effect: "write",
        available: false,
      },
    ],
  });

  it("shows opt-in write access as off until the capability is selected", () => {
    expect(capabilityAccessStateLabel(integration, capability)).toBe("Off");
    expect(capabilityUsesWriteTool(integration, capability.id)).toBe(true);
    expect(WRITE_TOOL_ACCESS_LABEL).toBe("Write · follows task access");
    expect(WRITE_TOOL_ACCESS_ARIA_LABEL).toBe("Write operation; follows task access mode");
  });

  it("distinguishes selected access that still needs provider authorization", () => {
    const selected = { ...capability, enabled: true, granted: false };
    expect(
      capabilityAccessStateLabel(
        summary({ ...integration, connectionState: "connected", capabilities: [selected] }),
        selected,
      ),
    ).toBe("Authorization required");
  });
});
