// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeBuiltinIntegrations } from "./builtins.ts";
import { RegistryRuntime } from "./IntegrationRegistry.ts";
import { CodexIntegrationSkillMaterializer } from "./IntegrationSkillMaterializer.ts";

function memorySecrets() {
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
  return service;
}

describe("built-in integration packages", () => {
  it("runs Graph, skill-only, and API-key/MCP package shapes through one registry", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-builtins-"));
    const codexHome = NodePath.join(root, "codex");
    const builtins = makeBuiltinIntegrations(memorySecrets());
    const registry = new RegistryRuntime(
      NodePath.join(root, "runtime"),
      builtins,
      new CodexIntegrationSkillMaterializer([codexHome]),
    );

    try {
      const graphPackage = builtins[0]!;
      const mailSkillPath = "skills/microsoft-365-mail/SKILL.md";
      const calendarSkillPath = "skills/microsoft-365-calendar/SKILL.md";
      const mailSkill = await NodeFSP.readFile(
        NodePath.join(graphPackage.sourceRoot!, mailSkillPath),
        "utf8",
      );
      const calendarSkill = await NodeFSP.readFile(
        NodePath.join(graphPackage.sourceRoot!, calendarSkillPath),
        "utf8",
      );
      expect(mailSkill).toBe(graphPackage.bundledFiles![mailSkillPath]);
      expect(calendarSkill).toBe(graphPackage.bundledFiles![calendarSkillPath]);
      expect(mailSkill).toContain("microsoft365_mail_search");
      expect(mailSkill).not.toContain("microsoft365.mail.search");
      expect(calendarSkill).toContain("microsoft365_calendar_events");
      expect(calendarSkill).not.toContain("microsoft365.calendar.events");

      const discovered = await registry.list();
      expect(discovered.integrations.map(({ id }) => id)).toEqual([
        "microsoft-365",
        "skill-only-fixture",
        "api-key-mcp-fixture",
      ]);

      const graphInstalled = await registry.install("microsoft-365");
      expect(graphInstalled.integrations.find(({ id }) => id === "microsoft-365")).toMatchObject({
        installed: true,
        connectionState: "not_connected",
      });

      const skillOnlyInstalled = await registry.install("skill-only-fixture");
      expect(
        skillOnlyInstalled.integrations.find(({ id }) => id === "skill-only-fixture"),
      ).toMatchObject({
        installed: true,
        connectionState: "connected",
        tools: [],
        skills: [{ name: "skill-only-fixture", available: true }],
      });

      await registry.install("api-key-mcp-fixture");
      const flow = await registry.connect("api-key-mcp-fixture", ["fixture.read"]);
      const connected = await registry.poll("api-key-mcp-fixture", flow.flowId);
      expect(connected.integration).toMatchObject({
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
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
