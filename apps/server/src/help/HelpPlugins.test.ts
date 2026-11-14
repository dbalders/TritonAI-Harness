import { describe, expect, it } from "@effect/vitest";
import { HelpKnowledge, HelpPlugin, type IntegrationSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { buildHelpPluginSnapshot } from "./HelpPlugins.ts";

const isHelpPlugin = Schema.is(HelpPlugin);
const isHelpKnowledge = Schema.is(HelpKnowledge);

function plugin(overrides: Partial<IntegrationSummary> = {}): IntegrationSummary {
  return {
    id: "example",
    name: "Example plugin",
    description: "Search documents and prepare a reply.",
    version: "1.2.3",
    apiVersion: "tritonai.harness/v2",
    installed: true,
    enabled: true,
    requiresConnection: true,
    connectionState: "connected",
    accountLabel: "private@example.test",
    statusMessage: "private provider response",
    capabilities: [
      {
        id: "read",
        displayName: "Read documents",
        description: "Read connected documents.",
        access: "authorization",
        enabled: true,
        granted: true,
        available: true,
      },
      {
        id: "write",
        displayName: "Write documents",
        description: "Update connected documents.",
        access: "opt-in",
        enabled: false,
        granted: true,
        available: false,
      },
    ],
    tools: [
      {
        name: "documents.search",
        displayName: "Search documents",
        description: "Search the selected account.",
        capabilities: ["read", "write"],
        effect: "read",
        available: true,
      },
    ],
    skills: [
      {
        name: "document-summary",
        description: "Summarize documents.",
        capabilities: ["read"],
        enabled: true,
        available: true,
      },
    ],
    ...overrides,
  };
}

const snapshot = (integrations: ReadonlyArray<IntegrationSummary>, question?: string) =>
  buildHelpPluginSnapshot({ integrations }, question);

describe("buildHelpPluginSnapshot", () => {
  it("allowlists fields and redacts untrusted text before truncating it", () => {
    const secret = "sk-proj-abcdef0123456789";
    const original = plugin();
    const input = plugin({
      name: `Plugin ${secret}`,
      description: "x".repeat(990) + secret,
      capabilities: original.capabilities.map((value) => ({
        ...value,
        description: "Access token=opaque-private-value\nBearer bearer-private-value",
      })),
      tools: original.tools.map((value) => ({
        ...value,
        description:
          "https://user:private-password@example.test/?code=private-code&sig=private-signature",
      })),
      skills: original.skills.map((value) => ({
        ...value,
        description:
          "-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----\u0000",
      })),
    });
    Object.defineProperties(input, {
      accountLabel: {
        get: () => {
          throw new Error("must not read account labels");
        },
      },
      statusMessage: {
        get: () => {
          throw new Error("must not read provider messages");
        },
      },
    });
    const result = snapshot([input]);
    const serialized = JSON.stringify(result);
    for (const value of [
      secret,
      "sk-proj-",
      "opaque-private-value",
      "bearer-private-value",
      "private-password",
      "private-code",
      "private-signature",
      "private-key-body",
      "accountLabel",
      "statusMessage",
      "displayName",
      "apiVersion",
    ]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).toContain("[REDACTED");
    expect(result.plugins[0]?.description).toHaveLength(1_000);
    expect(result.plugins[0]?.detailsOmitted).toBe(true);
    expect(result.plugins.every(isHelpPlugin)).toBe(true);
  });

  it("caps total details and description text, reports omissions, and stays within the wire schema", () => {
    const original = plugin();
    const large = plugin({
      id: "p".repeat(300),
      name: "n".repeat(300),
      version: "v".repeat(200),
      description: "d".repeat(4_000),
      capabilities: Array.from({ length: 120 }, (_, i) => ({
        ...original.capabilities[0]!,
        id: `cap-${i}`,
        displayName: "c".repeat(300),
        description: "d".repeat(4_000),
      })),
      tools: Array.from({ length: 180 }, (_, i) => ({
        ...original.tools[0]!,
        name: `tool-${i}`,
        description: "d".repeat(4_000),
      })),
      skills: Array.from({ length: 120 }, (_, i) => ({
        ...original.skills[0]!,
        name: `skill-${i}`,
        description: "d".repeat(4_000),
      })),
    });
    const result = snapshot(Array.from({ length: 105 }, () => large));
    expect(result.plugins).toHaveLength(100);
    expect(result.pluginsOmittedCount).toBe(5);
    expect(result.plugins.every(({ detailsOmitted }) => detailsOmitted)).toBe(true);
    const detailCount = result.plugins.reduce(
      (sum, entry) => sum + entry.capabilities.length + entry.tools.length + entry.skills.length,
      0,
    );
    const descriptionCharacters = result.plugins.reduce(
      (sum, entry) =>
        sum +
        entry.description.length +
        [...entry.capabilities, ...entry.tools, ...entry.skills].reduce(
          (n, item) => n + item.description.length,
          0,
        ),
      0,
    );
    expect(detailCount).toBe(200);
    expect(descriptionCharacters).toBe(32_000);
    expect(
      isHelpKnowledge({
        ...result,
        settings: { entries: [], totalCount: 0, omittedCount: 0 },
        documentation: [],
        documentationStatus: "unavailable",
      }),
    ).toBe(true);
  });
});
