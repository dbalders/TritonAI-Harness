// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off cryptoRandomUUID:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type IntegrationManifest, validateIntegrationManifest } from "./manifest.ts";
import {
  IntegrationProviderPublicError,
  RegistryRuntime,
  type IntegrationProvider,
  type IntegrationProviderStatus,
} from "./IntegrationRegistry.ts";
import {
  CodexIntegrationSkillMaterializer,
  type IntegrationSkillMaterializer,
} from "./IntegrationSkillMaterializer.ts";

const connectedManifest: IntegrationManifest = {
  apiVersion: "tritonai.harness/v1",
  kind: "IntegrationPlugin",
  manifestVersion: 1,
  id: "test-cloud-records",
  name: "Test Cloud Records",
  description: "Connected test package.",
  version: "1.0.0",
  compatibility: { harness: { min: "0.2.0", maxExclusive: "0.3.0" } },
  provider: "test-connected-provider",
  capabilities: [
    { id: "records.read", displayName: "Records", description: "Read records." },
    { id: "events.read", displayName: "Events", description: "Read events." },
  ],
  tools: [
    {
      name: "test.records.list",
      displayName: "List records",
      description: "List records.",
      capability: "records.read",
    },
    {
      name: "test.events.list",
      displayName: "List events",
      description: "List events.",
      capability: "events.read",
    },
  ],
  skills: [{ name: "test-records", description: "Records skill.", capability: "records.read" }],
};

const fixtureManifest: IntegrationManifest = {
  apiVersion: "tritonai.harness/v1",
  kind: "IntegrationPlugin",
  manifestVersion: 1,
  id: "test-fixture",
  name: "Test Fixture",
  description: "Independent test package.",
  version: "1.0.0",
  compatibility: { harness: { min: "0.2.0", maxExclusive: "0.3.0" } },
  provider: "test-fixture-provider",
  capabilities: [{ id: "fixture.read", displayName: "Fixture", description: "Read fixture." }],
  tools: [
    {
      name: "test.fixture.read",
      displayName: "Read fixture",
      description: "Read fixture.",
      capability: "fixture.read",
    },
  ],
  skills: [{ name: "fixture-reader", description: "Fixture skill.", capability: "fixture.read" }],
};

interface ProviderState {
  status: IntegrationProviderStatus;
  credential: string | null;
  disconnectFails: boolean;
}

function provider(id: string, state: ProviderState): IntegrationProvider {
  const names =
    id === "test-connected-provider"
      ? ["test.records.list", "test.events.list"]
      : ["test.fixture.read"];
  return {
    id,
    tools: names.map((name) => ({
      name,
      description: `Test definition for ${name}.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      readOnly: true,
      openWorld: false,
    })),
    status: async () => state.status,
    connect: async () => ({
      flowId: "flow-1",
      verificationUri: "https://fixture.invalid/device",
      verificationUriComplete: null,
      userCode: "ABCD-EFGH",
      message: "Sign in.",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      intervalSeconds: 1,
    }),
    poll: async () => {
      state.credential = "server-only";
      state.status = {
        state: "connected",
        accountLabel: "Test User",
        grantedCapabilities: ["records.read"],
        message: null,
      };
      return { state: "connected", retryAfterSeconds: null, message: "Connected." };
    },
    disconnect: async () => {
      if (state.disconnectFails) throw new Error("secure store unavailable");
      state.credential = null;
      state.status = {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      };
    },
    invoke: async (toolName) => ({ toolName, records: [] }),
  };
}

function packaged(manifest: IntegrationManifest, implementation: IntegrationProvider) {
  return {
    manifest,
    provider: implementation,
    bundledFiles: {
      ".tritonai-plugin/plugin.json": `${JSON.stringify(manifest)}\n`,
      ...Object.fromEntries(
        manifest.skills.map(({ name }) => [
          `skills/${name}/SKILL.md`,
          `---\nname: ${name}\ndescription: Test integration skill.\n---\n`,
        ]),
      ),
    },
  };
}

describe("IntegrationRegistry lifecycle", () => {
  it("rejects incompatible manifests and provider contracts before activation", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-compatibility-"));
    const state: ProviderState = {
      status: {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    try {
      expect(() =>
        validateIntegrationManifest({ ...connectedManifest, version: "1.0.0-../../victim" }),
      ).toThrow(/semver/u);
      expect(() =>
        validateIntegrationManifest({
          ...connectedManifest,
          compatibility: { harness: { min: "0.3.0", maxExclusive: "0.3.0" } },
        }),
      ).toThrow(/min < maxExclusive/u);
      const incompatible: IntegrationManifest = {
        ...connectedManifest,
        id: "future-integration",
        compatibility: { harness: { min: "99.0.0", maxExclusive: "100.0.0" } },
      };
      const runtime = new RegistryRuntime(root, [
        packaged(incompatible, provider("test-connected-provider", state)),
      ]);
      await expect(runtime.install(incompatible.id)).rejects.toMatchObject({
        code: "incompatible",
      });
      expect((await runtime.list()).integrations[0]?.installed).toBe(false);

      const completeProvider = provider("test-connected-provider", state);
      const mismatchedProvider: IntegrationProvider = {
        ...completeProvider,
        tools: completeProvider.tools.slice(1),
      };
      expect(
        () =>
          new RegistryRuntime(NodePath.join(root, "mismatch"), [
            packaged(connectedManifest, mismatchedProvider),
          ]),
      ).toThrow(/tool definitions do not match/u);

      const writableProvider: IntegrationProvider = {
        ...completeProvider,
        tools: completeProvider.tools.map((tool, index) =>
          index === 0 ? { ...tool, readOnly: false } : tool,
        ),
      };
      expect(
        () =>
          new RegistryRuntime(NodePath.join(root, "write-capable"), [
            packaged(connectedManifest, writableProvider),
          ]),
      ).toThrow(/write-capable integration tools are not supported/u);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("deactivates packages after Harness or catalog version drift", async () => {
    const incompatibleRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-incompatible-restart-"),
    );
    const mismatchRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-version-mismatch-"),
    );
    const connectedState = (): ProviderState => ({
      status: {
        state: "connected",
        accountLabel: "Test User",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "server-only",
      disconnectFails: false,
    });
    try {
      const compatibilityState = connectedState();
      const compatible = packaged(
        connectedManifest,
        provider("test-connected-provider", compatibilityState),
      );
      const initialCompatibilityRegistry = new RegistryRuntime(incompatibleRoot, [compatible]);
      await initialCompatibilityRegistry.install(connectedManifest.id);
      expect(initialCompatibilityRegistry.isToolAvailableSync("test.records.list")).toBe(true);

      const incompatibleManifest: IntegrationManifest = {
        ...connectedManifest,
        compatibility: { harness: { min: "99.0.0", maxExclusive: "100.0.0" } },
      };
      const incompatibleRegistry = new RegistryRuntime(incompatibleRoot, [
        packaged(incompatibleManifest, provider("test-connected-provider", compatibilityState)),
      ]);
      const incompatibleSummary = (await incompatibleRegistry.list()).integrations[0]!;
      expect(incompatibleSummary).toMatchObject({ compatible: false, installed: true });
      expect(incompatibleSummary.tools[0]?.available).toBe(false);
      expect(incompatibleSummary.skills[0]?.available).toBe(false);
      await expect(incompatibleRegistry.invokeTool("test.records.list", {})).rejects.toMatchObject({
        code: "incompatible",
      });
      await expect(
        incompatibleRegistry.connect(connectedManifest.id, ["records.read"]),
      ).rejects.toMatchObject({ code: "incompatible" });

      const mismatchState = connectedState();
      const initialMismatchRegistry = new RegistryRuntime(mismatchRoot, [
        packaged(connectedManifest, provider("test-connected-provider", mismatchState)),
      ]);
      await initialMismatchRegistry.install(connectedManifest.id);
      const nextManifest: IntegrationManifest = { ...connectedManifest, version: "2.0.0" };
      const mismatchRegistry = new RegistryRuntime(mismatchRoot, [
        packaged(nextManifest, provider("test-connected-provider", mismatchState)),
      ]);
      const mismatchSummary = (await mismatchRegistry.list()).integrations[0]!;
      expect(mismatchSummary).toMatchObject({ compatible: false, installed: true });
      expect(mismatchSummary.compatibilityMessage).toMatch(
        /Installed version 1\.0\.0 does not match discovered version 2\.0\.0/u,
      );
      expect(mismatchSummary.tools[0]?.available).toBe(false);
      await expect(mismatchRegistry.install(connectedManifest.id)).rejects.toMatchObject({
        code: "incompatible",
      });
      await expect(mismatchRegistry.invokeTool("test.records.list", {})).rejects.toMatchObject({
        code: "incompatible",
      });
      await mismatchRegistry.setEnabled(connectedManifest.id, false);
      await expect(mismatchRegistry.setEnabled(connectedManifest.id, true)).rejects.toMatchObject({
        code: "incompatible",
      });
    } finally {
      await NodeFSP.rm(incompatibleRoot, { recursive: true, force: true });
      await NodeFSP.rm(mismatchRoot, { recursive: true, force: true });
    }
  });

  it("exposes only explicitly public provider errors through lifecycle operations", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-provider-errors-"));
    const state: ProviderState = {
      status: {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    let usePublicConnectError = false;
    const baseProvider = provider("test-connected-provider", state);
    const failingProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async () => {
        if (usePublicConnectError) {
          throw new IntegrationProviderPublicError("Open the provider settings and try again.");
        }
        throw new Error("private account and credential material");
      },
      poll: async () => {
        throw new Error("private authorization response");
      },
      disconnect: async () => {
        throw new Error("private secret-store path");
      },
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, failingProvider)]);
      await registry.install(connectedManifest.id);
      await expect(registry.connect(connectedManifest.id, ["records.read"])).rejects.toMatchObject({
        code: "operation_failed",
        message: "Test Cloud Records authorization could not start. Try again.",
      });
      await expect(registry.poll(connectedManifest.id, "flow-1")).rejects.toMatchObject({
        code: "operation_failed",
        message: "Test Cloud Records authorization status could not be checked. Try again.",
      });
      await expect(registry.remove(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
        message:
          "Test Cloud Records could not disconnect, so removal stopped before changing installed state.",
      });

      usePublicConnectError = true;
      await expect(registry.connect(connectedManifest.id, ["records.read"])).rejects.toMatchObject({
        code: "operation_failed",
        message: "Open the provider settings and try again.",
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("discovers, installs, connects, gates, restarts, disables, disconnects, and removes through the real registry", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-integrations-"));
    const connectedState: ProviderState = {
      status: {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    const fixtureState: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["fixture.read"],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    try {
      const connectedProvider = provider("test-connected-provider", connectedState);
      const fixtureProvider = provider("test-fixture-provider", fixtureState);
      const registry = new RegistryRuntime(root, [
        packaged(connectedManifest, connectedProvider),
        packaged(fixtureManifest, fixtureProvider),
      ]);

      expect((await registry.list()).integrations).toHaveLength(2);
      await registry.install(connectedManifest.id);
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      const flow = await registry.connect(connectedManifest.id, ["records.read"]);
      const result = await registry.poll(connectedManifest.id, flow.flowId);
      expect(
        result.integration.tools.find(({ name }) => name === "test.records.list")?.available,
      ).toBe(true);
      expect(
        result.integration.tools.find(({ name }) => name === "test.events.list")?.available,
      ).toBe(false);
      expect(result.integration.skills[0]?.available).toBe(true);
      expect(JSON.stringify(result)).not.toContain("server-only");
      expect(await registry.invokeTool("test.records.list", {})).toEqual({
        toolName: "test.records.list",
        records: [],
      });

      const restarted = new RegistryRuntime(root, [
        packaged(connectedManifest, provider("test-connected-provider", connectedState)),
        packaged(fixtureManifest, fixtureProvider),
      ]);
      expect(
        (await restarted.list()).integrations.find(({ id }) => id === connectedManifest.id)
          ?.enabled,
      ).toBe(true);
      expect(restarted.isToolAvailableSync("test.records.list")).toBe(true);

      await restarted.setEnabled(connectedManifest.id, false);
      expect(restarted.isToolAvailableSync("test.records.list")).toBe(false);
      await expect(restarted.invokeTool("test.records.list", {})).rejects.toMatchObject({
        code: "disabled",
      });
      await restarted.setEnabled(connectedManifest.id, true);
      await restarted.disconnect(connectedManifest.id);
      expect(connectedState.credential).toBeNull();
      expect(restarted.isToolAvailableSync("test.records.list")).toBe(false);
      await restarted.remove(connectedManifest.id);
      expect(
        (await restarted.list()).integrations.find(({ id }) => id === connectedManifest.id)
          ?.installed,
      ).toBe(false);

      await restarted.install(fixtureManifest.id);
      expect(await restarted.invokeTool("test.fixture.read", {})).toEqual({
        toolName: "test.fixture.read",
        records: [],
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("loads a package manifest from .tritonai-plugin without core changes", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-integrations-discovery-"),
    );
    const packageRoot = NodePath.join(root, "package");
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: null,
        grantedCapabilities: ["fixture.read"],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    try {
      await NodeFSP.mkdir(NodePath.join(packageRoot, ".tritonai-plugin"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(packageRoot, ".tritonai-plugin", "plugin.json"),
        JSON.stringify(fixtureManifest),
      );
      await NodeFSP.writeFile(NodePath.join(packageRoot, "payload.txt"), "real package payload");
      await NodeFSP.mkdir(NodePath.join(packageRoot, "skills", "fixture-reader"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(packageRoot, "skills", "fixture-reader", "SKILL.md"),
        "---\nname: fixture-reader\ndescription: Test fixture skill.\n---\n",
      );
      const codexHome = NodePath.join(root, "codex");
      const registry = new RegistryRuntime(
        NodePath.join(root, "runtime"),
        [],
        new CodexIntegrationSkillMaterializer([codexHome]),
      );
      const observedTools: Array<string> = [];
      const stopObserving = registry.observeToolDefinitions(({ name }) => observedTools.push(name));
      await registry.discoverPackage(packageRoot, provider("test-fixture-provider", state));
      stopObserving();
      expect(observedTools).toEqual(["test.fixture.read"]);
      await registry.install(fixtureManifest.id);
      const installedManifest = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(
            root,
            "runtime",
            "installed",
            fixtureManifest.id,
            fixtureManifest.version,
            ".tritonai-plugin",
            "plugin.json",
          ),
          "utf8",
        ),
      );
      expect(installedManifest.id).toBe(fixtureManifest.id);
      expect(
        await NodeFSP.readFile(
          NodePath.join(
            root,
            "runtime",
            "installed",
            fixtureManifest.id,
            fixtureManifest.version,
            "payload.txt",
          ),
          "utf8",
        ),
      ).toBe("real package payload");
      const materializedSkill = NodePath.join(codexHome, "skills", "fixture-reader", "SKILL.md");
      expect(await NodeFSP.readFile(materializedSkill, "utf8")).toContain("fixture-reader");
      await registry.setEnabled(fixtureManifest.id, false);
      await expect(NodeFSP.access(materializedSkill)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked package content without changing installed state", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-package-safety-"));
    const packageRoot = NodePath.join(root, "package");
    const outside = NodePath.join(root, "outside-skill.md");
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: null,
        grantedCapabilities: ["fixture.read"],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    try {
      await NodeFSP.mkdir(NodePath.join(packageRoot, ".tritonai-plugin"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(packageRoot, "skills", "fixture-reader"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(packageRoot, ".tritonai-plugin", "plugin.json"),
        JSON.stringify(fixtureManifest),
      );
      await NodeFSP.writeFile(outside, "private local content");
      await NodeFSP.symlink(
        outside,
        NodePath.join(packageRoot, "skills", "fixture-reader", "SKILL.md"),
      );
      const registry = new RegistryRuntime(NodePath.join(root, "runtime"), []);
      await registry.discoverPackage(packageRoot, provider("test-fixture-provider", state));
      await expect(registry.install(fixtureManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
        message: expect.stringContaining("cannot contain symlinks"),
      });
      expect((await registry.list()).integrations[0]?.installed).toBe(false);
      await expect(
        NodeFSP.access(
          NodePath.join(root, "runtime", "installed", fixtureManifest.id, fixtureManifest.version),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked package root without changing installed state", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-package-root-safety-"),
    );
    const realPackageRoot = NodePath.join(root, "real-package");
    const packageRoot = NodePath.join(root, "package-link");
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: null,
        grantedCapabilities: ["fixture.read"],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    try {
      await NodeFSP.mkdir(NodePath.join(realPackageRoot, ".tritonai-plugin"), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        NodePath.join(realPackageRoot, ".tritonai-plugin", "plugin.json"),
        JSON.stringify(fixtureManifest),
      );
      await NodeFSP.symlink(realPackageRoot, packageRoot, "dir");
      const registry = new RegistryRuntime(NodePath.join(root, "runtime"), []);
      await registry.discoverPackage(packageRoot, provider("test-fixture-provider", state));
      await expect(registry.install(fixtureManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
        message: expect.stringContaining("source root must be a real directory"),
      });
      expect((await registry.list()).integrations[0]?.installed).toBe(false);
      await expect(
        NodeFSP.access(
          NodePath.join(root, "runtime", "installed", fixtureManifest.id, fixtureManifest.version),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back package and state when skill activation fails", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-install-rollback-"),
    );
    const codexHome = NodePath.join(root, "codex");
    const unmanagedSkill = NodePath.join(codexHome, "skills", "fixture-reader");
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: null,
        grantedCapabilities: ["fixture.read"],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    try {
      await NodeFSP.mkdir(unmanagedSkill, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(unmanagedSkill, "SKILL.md"), "unmanaged skill");
      const registry = new RegistryRuntime(
        NodePath.join(root, "runtime"),
        [packaged(fixtureManifest, provider("test-fixture-provider", state))],
        new CodexIntegrationSkillMaterializer([codexHome]),
      );
      await expect(registry.install(fixtureManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect((await registry.list()).integrations[0]?.installed).toBe(false);
      expect(registry.isToolAvailableSync("test.fixture.read")).toBe(false);
      expect(await NodeFSP.readFile(NodePath.join(unmanagedSkill, "SKILL.md"), "utf8")).toBe(
        "unmanaged skill",
      );
      await expect(
        NodeFSP.access(
          NodePath.join(root, "runtime", "installed", fixtureManifest.id, fixtureManifest.version),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps lifecycle controls readable when a skill collision appears after connection", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-skill-degraded-"));
    const codexHome = NodePath.join(root, "codex");
    const managedSkill = NodePath.join(codexHome, "skills", "fixture-reader");
    const unmanagedSkill = NodePath.join(codexHome, "skills", "fixture-reader-second");
    const degradedManifest: IntegrationManifest = {
      ...fixtureManifest,
      skills: [
        ...fixtureManifest.skills,
        {
          name: "fixture-reader-second",
          description: "Second fixture skill.",
          capability: "fixture.read",
        },
      ],
    };
    const state: ProviderState = {
      status: {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    try {
      await NodeFSP.mkdir(unmanagedSkill, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(unmanagedSkill, "SKILL.md"), "user-owned skill");
      const registry = new RegistryRuntime(
        root,
        [packaged(degradedManifest, provider("test-fixture-provider", state))],
        new CodexIntegrationSkillMaterializer([codexHome]),
      );
      await registry.install(fixtureManifest.id);
      state.status = {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["fixture.read"],
        message: null,
      };

      const degraded = (await registry.list()).integrations[0]!;
      expect(degraded.connectionState).toBe("connected");
      expect(degraded.tools[0]?.available).toBe(true);
      expect(degraded.skills[0]?.available).toBe(false);
      expect(degraded.skills[1]?.available).toBe(false);
      expect(degraded.statusMessage).toMatch(/Refusing to replace unmanaged Codex skill/u);
      await expect(NodeFSP.access(managedSkill)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(registry.setEnabled(fixtureManifest.id, false)).resolves.toBeDefined();
      await expect(registry.remove(fixtureManifest.id)).resolves.toBeDefined();
      expect(await NodeFSP.readFile(NodePath.join(unmanagedSkill, "SKILL.md"), "utf8")).toBe(
        "user-owned skill",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves installed state when credential removal fails", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-integrations-rollback-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: null,
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "credential",
      disconnectFails: true,
    };
    try {
      const registry = new RegistryRuntime(root, [
        packaged(connectedManifest, provider("test-connected-provider", state)),
      ]);
      await registry.install(connectedManifest.id);
      await expect(registry.remove(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect((await registry.list()).integrations[0]?.installed).toBe(true);
      expect(state.credential).toBe("credential");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("waits for in-flight authorization polling before removing credentials", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-poll-removal-"));
    const state: ProviderState = {
      status: {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    let releasePoll!: () => void;
    let markPollStarted!: () => void;
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve;
    });
    try {
      const baseProvider = provider("test-connected-provider", state);
      const delayedProvider: IntegrationProvider = {
        ...baseProvider,
        poll: async () => {
          markPollStarted();
          await pollGate;
          state.credential = "new-value";
          state.status = {
            state: "connected",
            accountLabel: "Test User",
            grantedCapabilities: ["records.read"],
            message: null,
          };
          return { state: "connected", retryAfterSeconds: null, message: "Connected." };
        },
      };
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, delayedProvider)]);
      await registry.install(connectedManifest.id);
      const polling = registry.poll(connectedManifest.id, "flow-1");
      await pollStarted;
      const removal = registry.remove(connectedManifest.id);
      releasePoll();
      await polling;
      await removal;
      expect(state.credential).toBeNull();
      expect((await registry.list()).integrations[0]?.installed).toBe(false);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("allows unrelated lifecycle work while another provider status is pending", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-provider-concurrency-"),
    );
    const connectedState: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Test User",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    const fixtureState: ProviderState = {
      status: {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    let delayStatus = false;
    let releaseStatus!: () => void;
    let markStatusStarted!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    try {
      const baseProvider = provider("test-connected-provider", connectedState);
      const delayedProvider: IntegrationProvider = {
        ...baseProvider,
        status: async () => {
          if (delayStatus) {
            delayStatus = false;
            markStatusStarted();
            await statusGate;
          }
          return connectedState.status;
        },
      };
      const registry = new RegistryRuntime(root, [
        packaged(connectedManifest, delayedProvider),
        packaged(fixtureManifest, provider("test-fixture-provider", fixtureState)),
      ]);
      await registry.install(connectedManifest.id);
      await registry.install(fixtureManifest.id);
      delayStatus = true;

      const listing = registry.list();
      await statusStarted;
      const unrelatedEnablement = registry.setEnabled(fixtureManifest.id, false);
      const completed = await Promise.race([
        unrelatedEnablement.then((result) => ({
          completed: true,
          enabled: result.integrations.find(({ id }) => id === fixtureManifest.id)?.enabled,
        })),
        new Promise<{ readonly completed: false }>((resolve) =>
          setTimeout(() => resolve({ completed: false }), 1_000),
        ),
      ]);

      expect(completed).toEqual({ completed: true, enabled: false });
      releaseStatus();
      await listing;
    } finally {
      releaseStatus?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("returns current state while another integration summary is still refreshing", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-summary-snapshot-"),
    );
    const connectedState: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Test User",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    const fixtureState: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture User",
        grantedCapabilities: ["fixture.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    let delayFixtureStatus = false;
    let releaseFixtureStatus!: () => void;
    let markFixtureStatusStarted!: () => void;
    const fixtureStatusGate = new Promise<void>((resolve) => {
      releaseFixtureStatus = resolve;
    });
    const fixtureStatusStarted = new Promise<void>((resolve) => {
      markFixtureStatusStarted = resolve;
    });
    try {
      const baseFixtureProvider = provider("test-fixture-provider", fixtureState);
      const delayedFixtureProvider: IntegrationProvider = {
        ...baseFixtureProvider,
        status: async () => {
          if (delayFixtureStatus) {
            delayFixtureStatus = false;
            markFixtureStatusStarted();
            await fixtureStatusGate;
          }
          return fixtureState.status;
        },
      };
      const registry = new RegistryRuntime(root, [
        packaged(connectedManifest, provider("test-connected-provider", connectedState)),
        packaged(fixtureManifest, delayedFixtureProvider),
      ]);
      await registry.install(connectedManifest.id);
      await registry.install(fixtureManifest.id);
      delayFixtureStatus = true;

      const fixtureDisablement = registry.setEnabled(fixtureManifest.id, false);
      await fixtureStatusStarted;
      const unrelatedResult = await registry.setEnabled(connectedManifest.id, false);
      const fixtureSummary = unrelatedResult.integrations.find(
        ({ id }) => id === fixtureManifest.id,
      );

      expect(fixtureSummary).toMatchObject({ installed: true, enabled: false });
      expect(fixtureSummary?.tools.every(({ available }) => !available)).toBe(true);
      expect(fixtureSummary?.skills.every(({ available }) => !available)).toBe(true);
      releaseFixtureStatus();
      await fixtureDisablement;
    } finally {
      releaseFixtureStatus?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("revokes tool availability and aborts in-flight work before disable completes", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-tool-disable-"));
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Test User",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    try {
      const baseProvider = provider("test-connected-provider", state);
      const delayedProvider: IntegrationProvider = {
        ...baseProvider,
        invoke: async (_toolName, _input, context) => {
          markToolStarted();
          return new Promise((_resolve, reject) => {
            context?.signal.addEventListener(
              "abort",
              () => reject(new Error("fixture invocation aborted")),
              { once: true },
            );
          });
        },
      };
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, delayedProvider)]);
      await registry.install(connectedManifest.id);
      expect(registry.isSkillAvailableSync("test-records")).toBe(true);
      const invocation = registry.invokeTool("test.records.list", {});
      await toolStarted;
      const disabling = registry.setEnabled(connectedManifest.id, false);
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      expect(registry.isSkillAvailableSync("test-records")).toBe(false);
      await expect(invocation).rejects.toThrow(/revoked/u);
      await disabling;
      expect((await registry.list()).integrations[0]?.enabled).toBe(false);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("admits skill turns atomically and waits for their submission before revoking", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-skill-reservation-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Test User",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    try {
      const registry = new RegistryRuntime(root, [
        packaged(connectedManifest, provider("test-connected-provider", state)),
      ]);
      await registry.install(connectedManifest.id);
      const reservation = registry.reserveSkillsSync(["test-records"]);
      expect(reservation).not.toBeNull();

      let disableCompleted = false;
      const disabling = registry.setEnabled(connectedManifest.id, false);
      void disabling.then(() => {
        disableCompleted = true;
      });

      expect(registry.isSkillAvailableSync("test-records")).toBe(false);
      expect(registry.reserveSkillsSync(["test-records"])).toBeNull();
      await Promise.resolve();
      expect(disableCompleted).toBe(false);

      reservation!.release();
      await disabling;
      expect(disableCompleted).toBe(true);
      reservation!.release();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("does not enter provider work when status resolves after revocation completes", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-status-disable-"));
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Test User",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    let delayNextStatus = false;
    let providerInvoked = false;
    let releaseStatus!: () => void;
    let markStatusStarted!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    try {
      const baseProvider = provider("test-connected-provider", state);
      const delayedProvider: IntegrationProvider = {
        ...baseProvider,
        status: async () => {
          if (delayNextStatus) {
            delayNextStatus = false;
            markStatusStarted();
            await statusGate;
          }
          return state.status;
        },
        invoke: async () => {
          providerInvoked = true;
          return { records: [] };
        },
      };
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, delayedProvider)]);
      await registry.install(connectedManifest.id);
      delayNextStatus = true;

      const invocation = registry.invokeTool("test.records.list", {});
      await statusStarted;
      await registry.setEnabled(connectedManifest.id, false);
      releaseStatus();

      await expect(invocation).rejects.toThrow(/revoked/u);
      expect(providerInvoked).toBe(false);
    } finally {
      releaseStatus?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("restores active skills when disable deactivation partially fails", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-disable-rollback-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["fixture.read"],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    let skillActive = false;
    const materializer: IntegrationSkillMaterializer = {
      sync: async ({ activeSkills }) => {
        if (activeSkills.length === 0) {
          skillActive = false;
          throw new Error("second Codex home is unavailable");
        }
        skillActive = true;
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(fixtureManifest, provider("test-fixture-provider", state))],
        materializer,
      );
      await registry.install(fixtureManifest.id);
      expect(skillActive).toBe(true);
      await expect(registry.setEnabled(fixtureManifest.id, false)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect(skillActive).toBe(true);
      expect((await registry.list()).integrations[0]?.enabled).toBe(true);
      expect(registry.isToolAvailableSync("test.fixture.read")).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps removed state isolated when tombstone cleanup fails", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-remove-package-"));
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["fixture.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(fixtureManifest, provider("test-fixture-provider", state))],
        undefined,
        async () => {
          throw new Error("package directory is locked");
        },
      );
      await registry.install(fixtureManifest.id);
      await expect(registry.remove(fixtureManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect((await registry.list()).integrations[0]?.installed).toBe(false);
      expect(state.credential).toBeNull();
      await expect(
        NodeFSP.access(NodePath.join(root, "installed", fixtureManifest.id)),
      ).rejects.toThrow();
      expect((await NodeFSP.readdir(NodePath.join(root, ".trash"))).length).toBe(1);

      const restarted = new RegistryRuntime(root, [
        packaged(fixtureManifest, provider("test-fixture-provider", state)),
      ]);
      expect((await restarted.list()).integrations[0]?.installed).toBe(false);
      await expect(NodeFSP.access(NodePath.join(root, ".trash"))).rejects.toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("completes a removal interrupted after the tombstone move on restart", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-remove-restart-"));
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["fixture.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    try {
      const integration = packaged(fixtureManifest, provider("test-fixture-provider", state));
      const registry = new RegistryRuntime(root, [integration]);
      await registry.install(fixtureManifest.id);
      state.credential = null;
      state.status = {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      };
      const tombstoneName = `${fixtureManifest.id}.interrupted`;
      await NodeFSP.mkdir(NodePath.join(root, ".trash"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(root, "state.json"),
        `${JSON.stringify({
          version: 1,
          installed: {
            [fixtureManifest.id]: { version: fixtureManifest.version, enabled: true },
          },
          removing: {
            [fixtureManifest.id]: {
              version: fixtureManifest.version,
              tombstone: tombstoneName,
            },
          },
        })}\n`,
      );
      await NodeFSP.rename(
        NodePath.join(root, "installed", fixtureManifest.id),
        NodePath.join(root, ".trash", tombstoneName),
      );

      const restarted = new RegistryRuntime(root, [integration]);
      expect((await restarted.list()).integrations[0]?.installed).toBe(false);
      await expect(NodeFSP.access(NodePath.join(root, ".trash"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const persisted = JSON.parse(
        await NodeFSP.readFile(NodePath.join(root, "state.json"), "utf8"),
      );
      expect(persisted).toMatchObject({ installed: {}, removing: {} });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("waits for in-flight connect before removing generic provider credentials", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-connect-remove-"));
    const state: ProviderState = {
      status: {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      },
      credential: null,
      disconnectFails: false,
    };
    let releaseConnect!: () => void;
    let markConnectStarted!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    try {
      const baseProvider = provider("test-connected-provider", state);
      const delayedProvider: IntegrationProvider = {
        ...baseProvider,
        connect: async () => {
          markConnectStarted();
          await connectGate;
          state.credential = "new-value";
          return baseProvider.connect(["records.read"]);
        },
      };
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, delayedProvider)]);
      await registry.install(connectedManifest.id);
      const connecting = registry.connect(connectedManifest.id, ["records.read"]);
      await connectStarted;
      const removal = registry.remove(connectedManifest.id);
      releaseConnect();
      await connecting;
      await removal;
      expect(state.credential).toBeNull();
      expect((await registry.list()).integrations[0]?.installed).toBe(false);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
