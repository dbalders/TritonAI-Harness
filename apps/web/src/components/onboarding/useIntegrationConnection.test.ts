import type { IntegrationSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { connectionStatusFor } from "./useIntegrationConnection";

const mailRead = {
  id: "mail.read",
  displayName: "Read mail",
  description: "Read mail",
  access: "default" as const,
  enabled: true,
  granted: true,
  available: true,
};

const outlook = (patch: Partial<IntegrationSummary>) =>
  ({
    id: "microsoft-365",
    name: "Microsoft 365",
    installed: true,
    enabled: true,
    requiresConnection: true,
    connectionState: "not_connected",
    capabilities: [mailRead],
    tools: [],
    ...patch,
  }) as unknown as IntegrationSummary;

const status = (integration: IntegrationSummary | null, error: string | null = null) =>
  connectionStatusFor({ loading: false, integration, starting: false, flow: null, error });

describe("connectionStatusFor", () => {
  it("is connected only when the plugin is signed in, installed, enabled and authorized", () => {
    expect(status(outlook({ connectionState: "connected" }))).toBe("connected");
    expect(status(outlook({ connectionState: "connected", enabled: false }))).toBe("ready");
    expect(status(outlook({ connectionState: "connected", installed: false }))).toBe("ready");
    // A capability turned on after signing in still needs Microsoft's approval.
    expect(
      status(
        outlook({
          connectionState: "connected",
          capabilities: [mailRead, { ...mailRead, id: "calendar.read", granted: false }],
        }),
      ),
    ).toBe("ready");
  });

  it("is failed, not unavailable, when the plugin list couldn't be read", () => {
    expect(
      connectionStatusFor({
        loading: false,
        loadFailed: true,
        integration: null,
        starting: false,
        flow: null,
        error: null,
      }),
    ).toBe("failed");
  });

  it("is unavailable when this environment has no such plugin", () => {
    expect(status(null)).toBe("unavailable");
  });

  it("offers to try again after a failed sign-in", () => {
    expect(status(outlook({}), "The sign-in expired. Try again.")).toBe("failed");
  });
});
