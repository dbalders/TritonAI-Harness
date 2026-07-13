// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  RegistryRuntime,
  type IntegrationProvider,
  type IntegrationProviderStatus,
} from "./IntegrationRegistry.ts";
import { CodexIntegrationSkillMaterializer } from "./IntegrationSkillMaterializer.ts";
import { manifestCompatibility, validateIntegrationManifest } from "./manifest.ts";

const fixtureManifest = {
  apiVersion: "tritonai.harness/v1",
  kind: "IntegrationPlugin",
  manifestVersion: 1,
  id: "acceptance-fixture",
  name: "Acceptance Fixture",
  description: "Test-only package for the generic integration runtime.",
  version: "1.0.0",
  compatibility: { harness: { min: "0.2.0", maxExclusive: "0.3.0" } },
  provider: "acceptance-fixture-provider",
  capabilities: [
    { id: "fixture.read", displayName: "Read fixture", description: "Read fixture data." },
  ],
  tools: [
    {
      name: "acceptance.fixture.read",
      displayName: "Read fixture",
      description: "Read deterministic fixture data.",
      capability: "fixture.read",
    },
  ],
  skills: [
    { name: "acceptance-fixture", description: "Fixture skill.", capability: "fixture.read" },
  ],
} as const;

interface FixtureState {
  status: IntegrationProviderStatus;
  credential: string | null;
}

function disconnectedState(): FixtureState {
  return {
    status: {
      state: "not_connected",
      accountLabel: null,
      grantedCapabilities: [],
      message: null,
    },
    credential: null,
  };
}

function fixtureProvider(state: FixtureState): IntegrationProvider {
  return {
    id: "acceptance-fixture-provider",
    tools: [
      {
        name: "acceptance.fixture.read",
        description: "Read deterministic fixture data.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        readOnly: true,
        openWorld: false,
      },
    ],
    status: async () => state.status,
    connect: async (capabilities) => {
      if (!capabilities.includes("fixture.read")) throw new Error("Read access is required.");
      state.status = {
        state: "connecting",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Waiting for fixture authorization.",
      };
      return {
        flowId: "fixture-flow",
        verificationUri: "https://fixture.invalid/activate",
        verificationUriComplete: null,
        userCode: "FIXTURE-CODE",
        message: "Authorize the test fixture.",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        intervalSeconds: 1,
      };
    },
    poll: async (flowId) => {
      if (flowId !== "fixture-flow") throw new Error("Unknown authorization flow.");
      state.credential = "server-only-fixture-credential";
      state.status = {
        state: "connected",
        accountLabel: "Fixture account",
        grantedCapabilities: ["fixture.read"],
        message: null,
      };
      return { state: "connected", retryAfterSeconds: null, message: "Connected." };
    },
    disconnect: async () => {
      state.credential = null;
      state.status = {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      };
    },
    invoke: async () => {
      if (!state.credential) throw new Error("Fixture is not connected.");
      return { source: "fixture", ok: true };
    },
  };
}

describe("integration plugin acceptance", () => {
  it("runs an external test package through the complete generic lifecycle", async () => {
    const temporary = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-plugin-acceptance-"),
    );
    const packageRoot = NodePath.join(temporary, "external-fixture-package");
    const runtimeRoot = NodePath.join(temporary, "runtime");
    const codexHome = NodePath.join(temporary, "codex");
    const state = disconnectedState();

    try {
      expect(manifestCompatibility(validateIntegrationManifest(fixtureManifest))).toEqual({
        compatible: true,
        message: null,
      });
      await NodeFSP.mkdir(NodePath.join(packageRoot, ".tritonai-plugin"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(packageRoot, "skills", "acceptance-fixture"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(packageRoot, ".tritonai-plugin", "plugin.json"),
        `${JSON.stringify(fixtureManifest, null, 2)}\n`,
      );
      await NodeFSP.writeFile(
        NodePath.join(packageRoot, "skills", "acceptance-fixture", "SKILL.md"),
        "---\nname: acceptance-fixture\ndescription: Test-only fixture skill.\n---\n",
      );

      const registry = new RegistryRuntime(
        runtimeRoot,
        [],
        new CodexIntegrationSkillMaterializer([codexHome]),
      );
      await registry.discoverPackage(packageRoot, fixtureProvider(state));
      expect((await registry.list()).integrations).toHaveLength(1);

      await registry.install(fixtureManifest.id);
      expect(registry.isToolAvailableSync("acceptance.fixture.read")).toBe(false);
      const flow = await registry.connect(fixtureManifest.id, ["fixture.read"]);
      const connected = await registry.poll(fixtureManifest.id, flow.flowId);
      expect(state.credential).toBe("server-only-fixture-credential");
      expect(JSON.stringify({ flow, connected })).not.toContain(state.credential);
      expect(connected.integration.tools[0]?.available).toBe(true);
      expect(connected.integration.skills[0]?.available).toBe(true);
      expect(await registry.invokeTool("acceptance.fixture.read", {})).toEqual({
        source: "fixture",
        ok: true,
      });

      const materializedSkill = NodePath.join(
        codexHome,
        "skills",
        "acceptance-fixture",
        "SKILL.md",
      );
      expect(await NodeFSP.readFile(materializedSkill, "utf8")).toContain(
        "Test-only fixture skill",
      );

      await registry.setEnabled(fixtureManifest.id, false);
      expect(registry.isToolAvailableSync("acceptance.fixture.read")).toBe(false);
      await expect(registry.invokeTool("acceptance.fixture.read", {})).rejects.toMatchObject({
        code: "disabled",
      });
      await expect(NodeFSP.access(materializedSkill)).rejects.toMatchObject({ code: "ENOENT" });

      const restarted = new RegistryRuntime(
        runtimeRoot,
        [],
        new CodexIntegrationSkillMaterializer([codexHome]),
      );
      await restarted.discoverPackage(packageRoot, fixtureProvider(state));
      expect(
        (await restarted.list()).integrations.find(({ id }) => id === fixtureManifest.id)?.enabled,
      ).toBe(false);

      await restarted.setEnabled(fixtureManifest.id, true);
      expect(await restarted.invokeTool("acceptance.fixture.read", {})).toEqual({
        source: "fixture",
        ok: true,
      });
      await restarted.remove(fixtureManifest.id);
      expect(state.credential).toBeNull();
      expect(
        (await restarted.list()).integrations.find(({ id }) => id === fixtureManifest.id)
          ?.installed,
      ).toBe(false);
      expect(restarted.isToolAvailableSync("acceptance.fixture.read")).toBe(false);
      await expect(
        NodeFSP.access(NodePath.join(runtimeRoot, "installed", fixtureManifest.id)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.access(materializedSkill)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
    }
  });
});
