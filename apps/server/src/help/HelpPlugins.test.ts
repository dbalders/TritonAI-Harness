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
  it("keeps installed, disabled, and uninstalled inventory with selection and grants distinct", () => {
    const original = plugin();
    const result = snapshot([
      original,
      plugin({ id: "disabled", enabled: false }),
      plugin({ id: "catalog", installed: false, enabled: false, connectionState: "not_connected" }),
    ]);
    expect(result.pluginsStatus).toBe("reported");
    expect(result.pluginsOmittedCount).toBe(0);
    expect(
      result.plugins.map(({ id, installed, enabled }) => ({ id, installed, enabled })),
    ).toEqual([
      { id: "example", installed: true, enabled: true },
      { id: "disabled", installed: true, enabled: false },
      { id: "catalog", installed: false, enabled: false },
    ]);
    expect(result.plugins[0]?.capabilities[1]).toEqual({
      id: "write",
      name: "Write documents",
      description: "Update connected documents.",
      access: "opt-in",
      enabled: false,
      granted: true,
      available: false,
    });
    expect(result.plugins[0]?.tools[0]).toEqual({
      name: "documents.search",
      description: "Search the selected account.",
      effect: "read",
      available: true,
      capabilities: ["read", "write"],
    });
    for (const entry of result.plugins.slice(1)) {
      expect(entry.capabilities[0]).toMatchObject({
        enabled: true,
        granted: true,
        available: false,
      });
      expect(entry.skills[0]).toMatchObject({ enabled: true, available: false });
      expect(entry.tools[0]?.available).toBe(false);
    }
    expect(result.plugins.every(isHelpPlugin)).toBe(true);
    expect(result.plugins.every(({ detailsOmitted }) => !detailsOmitted)).toBe(true);
    expect(original.tools[0]?.available).toBe(true);
  });

  it("retains cached fail-closed flags for revocation, version mismatch, and skill materialization", () => {
    const original = plugin();
    const unavailable = plugin({
      capabilities: original.capabilities.map((value) => ({ ...value, available: false })),
      tools: original.tools.map((value) => ({ ...value, available: false })),
      skills: original.skills.map((value) => ({ ...value, available: false })),
    });
    const result = snapshot([unavailable]).plugins[0]!;
    expect(result).toMatchObject({ installed: true, enabled: true, connectionState: "connected" });
    expect(result.capabilities[0]).toMatchObject({
      enabled: true,
      granted: true,
      available: false,
    });
    expect(result.tools[0]?.available).toBe(false);
    expect(result.skills[0]).toMatchObject({ enabled: true, available: false });

    const skillFailure = snapshot([plugin({ skills: unavailable.skills })]).plugins[0]!;
    expect(skillFailure.capabilities[0]?.available).toBe(true);
    expect(skillFailure.tools[0]?.available).toBe(true);
    expect(skillFailure.skills[0]?.available).toBe(false);
  });

  it("requires one same dependency to be selected, granted, and available, using OR semantics", () => {
    const original = plugin();
    const split = plugin({
      capabilities: [
        { ...original.capabilities[0]!, enabled: true, granted: false, available: true },
        { ...original.capabilities[1]!, enabled: false, granted: true, available: true },
      ],
    });
    expect(snapshot([split]).plugins[0]?.tools[0]?.available).toBe(false);
    expect(snapshot([original]).plugins[0]?.tools[0]?.available).toBe(true);
    expect(
      snapshot([plugin({ connectionState: "connecting" })]).plugins[0]?.tools[0]?.available,
    ).toBe(false);
  });

  it("supports local skill-only packages without inventing a connection requirement", () => {
    const result = snapshot([plugin({ requiresConnection: false, tools: [] })]).plugins[0]!;
    expect(result.requiresConnection).toBe(false);
    expect(result.skills[0]?.available).toBe(true);
  });

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

  it.each(["plugin", "capability", "tool", "skill"] as const)(
    "prioritizes a queried %s beyond the default inventory/detail limits",
    (kind) => {
      const original = plugin();
      const target = plugin({
        id: "target-plugin",
        name: "Target plugin",
        capabilities: Array.from({ length: 120 }, (_, i) => ({
          ...original.capabilities[0]!,
          id: i === 119 ? "queried-capability" : `access-${i}`,
          displayName: `Access ${i}`,
        })),
        tools: Array.from({ length: 180 }, (_, i) => ({
          ...original.tools[0]!,
          name: i === 179 ? "queried_tool" : `tool-${i}`,
        })),
        skills: Array.from({ length: 120 }, (_, i) => ({
          ...original.skills[0]!,
          name: i === 119 ? "queried-skill" : `skill-${i}`,
        })),
      });
      const question = {
        plugin: "How do I enable target-plugin?",
        capability: "Why is queried-capability unavailable?",
        tool: "Can I use queried_tool?",
        skill: "Where is queried-skill?",
      }[kind];
      const entries = [
        ...Array.from({ length: 101 }, (_, i) => plugin({ id: `other-${i}` })),
        target,
      ];
      const before = JSON.stringify(entries);
      const result = snapshot(entries, question);
      expect(result.plugins[0]?.id).toBe("target-plugin");
      expect(result.pluginsOmittedCount).toBe(2);
      const first = result.plugins[0]!;
      if (kind === "capability")
        expect(first.capabilities.some(({ id }) => id === "queried-capability")).toBe(true);
      if (kind === "tool")
        expect(first.tools.some(({ name }) => name === "queried_tool")).toBe(true);
      if (kind === "skill")
        expect(first.skills.some(({ name }) => name === "queried-skill")).toBe(true);
      expect(JSON.stringify(entries)).toBe(before);
    },
  );

  it("checks dependencies against complete original IDs before display truncation", () => {
    const original = plugin();
    const input = plugin({
      capabilities: Array.from({ length: 110 }, (_, i) => ({
        ...original.capabilities[0]!,
        id: i === 109 ? "hidden-dependency" : `access-${i}`,
        displayName: `Access ${i}`,
      })),
      tools: [{ ...original.tools[0]!, capabilities: ["missing", "hidden-dependency"] }],
      skills: [],
    });
    const result = snapshot([input], "documents.search").plugins[0]!;
    expect(result.capabilities).toHaveLength(100);
    expect(result.capabilities.some(({ id }) => id === "hidden-dependency")).toBe(false);
    expect(result.tools[0]?.available).toBe(true);
    expect(result.detailsOmitted).toBe(true);
  });

  it("prefers an exact tool name over repeated display names and keeps short plugin names", () => {
    const original = plugin();
    const input = plugin({
      tools: Array.from({ length: 180 }, (_, i) => ({
        ...original.tools[0]!,
        name: i === 179 ? "search.documents" : `tool-${i}`,
        displayName: "Search documents",
      })),
    });
    expect(snapshot([input], "search.documents").plugins[0]?.tools[0]?.name).toBe(
      "search.documents",
    );
    const entries = [
      ...Array.from({ length: 101 }, (_, i) => plugin({ id: `other-${i}` })),
      plugin({ id: "ai", name: "AI", tools: [], skills: [], capabilities: [] }),
    ];
    expect(snapshot(entries, "How do I enable AI?").plugins[0]?.id).toBe("ai");
  });

  it("reports a known empty snapshot without fabricating unavailable inventory", () => {
    expect(snapshot([])).toEqual({
      pluginsStatus: "reported",
      plugins: [],
      pluginsOmittedCount: 0,
    });
  });
});
