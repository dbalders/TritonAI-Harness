// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { loadBuiltinIntegrations } from "./builtins.ts";
import { makeFixtureIntegrations } from "./fixtureBuiltins.ts";
import { RegistryRuntime } from "./IntegrationRegistry.ts";
import { CodexIntegrationSkillMaterializer } from "./IntegrationSkillMaterializer.ts";

function memorySecretState() {
  const values = new Map<string, Uint8Array>();
  const service = {
    get: (name: string) =>
      Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
    set: (name: string, value: Uint8Array) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      }),
    create: (name: string, value: Uint8Array) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
    remove: (name: string) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"];
  return { service, values };
}

function memorySecrets() {
  return memorySecretState().service;
}

describe("built-in integration packages", () => {
  it("keeps proof fixtures out of the default catalog", async () => {
    expect(await loadBuiltinIntegrations(memorySecrets())).toEqual([]);
  });

  it("injects package-scoped credentials into provider factories", async () => {
    const secrets = memorySecretState();
    const fixture = makeFixtureIntegrations(secrets.service).find(
      ({ manifest }) => manifest.id === "api-key-mcp-fixture",
    );
    if (!fixture?.provider?.connect) {
      throw new Error("API-key fixture provider was not assembled.");
    }

    const flow = await fixture.provider.connect(["fixture.read"]);
    await fixture.provider.connect(["fixture.read"], undefined, {
      kind: "api_key",
      flowId: flow.flowId,
      value: "fixture-submitted-key",
    });

    expect(secrets.values.has("api-key")).toBe(false);
    expect(secrets.values.has("integration-api-key-mcp-fixture--api-key")).toBe(true);
  });

  it("runs skill-only and authenticated tool package shapes through one registry", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-builtins-"));
    const codexHome = NodePath.join(root, "codex");
    const builtins = makeFixtureIntegrations(memorySecrets());
    expect(builtins.every(({ bundledFiles }) => bundledFiles === undefined)).toBe(true);
    const registry = new RegistryRuntime(
      NodePath.join(root, "runtime"),
      builtins,
      new CodexIntegrationSkillMaterializer([codexHome]),
    );

    try {
      const discovered = await registry.list();
      expect(discovered.integrations.map(({ id }) => id)).toEqual([
        "skill-only-fixture",
        "api-key-mcp-fixture",
      ]);

      const skillOnlyInstalled = await registry.install("skill-only-fixture");
      expect(
        skillOnlyInstalled.integrations.find(({ id }) => id === "skill-only-fixture"),
      ).toMatchObject({
        installed: true,
        requiresConnection: false,
        connectionState: "connected",
        tools: [],
        skills: [{ name: "skill-only-fixture", available: true }],
      });
      await expect(registry.connect("skill-only-fixture")).rejects.toMatchObject({
        code: "operation_failed",
        message: "Skill-only Fixture does not require a connection.",
      });

      await registry.install("api-key-mcp-fixture");
      const flow = await registry.connect("api-key-mcp-fixture");
      const connected = await registry.connect("api-key-mcp-fixture", {
        kind: "api_key",
        flowId: flow.flowId,
        value: "fixture-submitted-key",
      });
      expect(connected.kind).toBe("connected");
      expect((await registry.list()).integrations[1]).toMatchObject({
        connectionState: "connected",
        tools: [{ name: "fixture.api-key.read", available: true }],
        skills: [{ name: "authenticated-mcp-fixture", available: true }],
      });
      expect(await registry.invokeTool("fixture.api-key.read", {})).toMatchObject({
        authenticated: true,
        value: "api-key-fixture-ok",
      });

      const runtime = await registry.prepareSkillRuntime();
      expect(runtime?.skills.map(({ name }) => name).sort()).toEqual([
        "authenticated-mcp-fixture",
        "skill-only-fixture",
      ]);
      expect(
        await NodeFSP.readFile(
          NodePath.join(runtime!.root, "skill-only-fixture", "skill-only-fixture", "SKILL.md"),
          "utf8",
        ),
      ).toContain("skill-only-fixture-ok");
      expect(
        await NodeFSP.readFile(
          NodePath.join(
            runtime!.root,
            "authenticated-mcp-fixture",
            "authenticated-mcp-fixture",
            "agents",
            "openai.yaml",
          ),
          "utf8",
        ),
      ).toContain("API Key MCP Fixture");
      await registry.releaseSkillRuntime(runtime!.root);
      await expect(NodeFSP.access(runtime!.root)).rejects.toMatchObject({ code: "ENOENT" });

      const skillOnlyDisabled = await registry.setEnabled("skill-only-fixture", false);
      expect(
        skillOnlyDisabled.integrations.find(({ id }) => id === "skill-only-fixture"),
      ).toMatchObject({ enabled: false, skills: [{ available: false }] });
      await registry.setEnabled("skill-only-fixture", true);
      expect(registry.isSkillAvailableSync("skill-only-fixture")).toBe(true);
      const skillOnlyRemoved = await registry.remove("skill-only-fixture");
      expect(
        skillOnlyRemoved.integrations.find(({ id }) => id === "skill-only-fixture")?.installed,
      ).toBe(false);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
