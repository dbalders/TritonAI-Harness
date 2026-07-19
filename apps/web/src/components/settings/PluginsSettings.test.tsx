import type { IntegrationSummary } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  IntegrationConnectionActionCallout,
  capabilityAccessStateLabel,
  capabilityUsesWriteTool,
  clearOwnedConnectionAttention,
  integrationConnectAriaLabel,
  integrationNeedsConnectionAction,
  reconcileConnectionAttentionForIntegration,
  shouldExpandIntegrationCard,
  shouldFocusConnectionAction,
} from "./PluginsSettings.tsx";

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
