// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { RegistryRuntime, type IntegrationPackage } from "./IntegrationRegistry.ts";
import { EmptyIntegrationToolInput } from "./IntegrationTool.ts";
import type { IntegrationManifest } from "./manifest.ts";

// Declared synthetic package; this does not exercise the production UCSD provider or sources.
const assistantManifest: IntegrationManifest = {
  apiVersion: "tritonai.harness/v2",
  kind: "IntegrationPlugin",
  manifestVersion: 2,
  id: "ucsd-assistant",
  name: "Synthetic UCSD Assistant",
  description: "Synthetic public-source reader.",
  version: "1.0.0",
  provider: "synthetic-ucsd-assistant",
  capabilities: [
    { id: "public.read", displayName: "Read", description: "Read fixture.", access: "default" },
    { id: "extra.read", displayName: "Extra", description: "Extra fixture.", access: "opt-in" },
  ],
  tools: [
    {
      name: "synthetic.ucsd.read",
      displayName: "Read fixture",
      description: "Read synthetic public data.",
      capabilities: ["public.read"],
      effect: "read",
    },
  ],
  skills: [
    {
      name: "synthetic-ucsd-reader",
      description: "Synthetic skill.",
      capabilities: ["public.read"],
    },
  ],
};

function syntheticPackage(manifest = assistantManifest): IntegrationPackage {
  return {
    manifest,
    provider: {
      id: manifest.provider!,
      tools: manifest.tools.map(({ name, description }) => ({
        name,
        description,
        input: EmptyIntegrationToolInput,
        readOnly: true,
        openWorld: false,
      })),
      status: async () => ({
        state: "connected",
        accountLabel: null,
        grantedCapabilities: manifest.capabilities.map(({ id }) => id),
        message: "Synthetic stateless provider.",
      }),
      invoke: async () => ({ source: "synthetic", records: [] }),
    },
    bundledFiles: {
      ".tritonai-plugin/plugin.json": JSON.stringify(manifest),
      ...Object.fromEntries(
        manifest.skills.map(({ name }) => [
          `skills/${name}/SKILL.md`,
          `---\nname: ${name}\ndescription: Synthetic skill.\n---\n`,
        ]),
      ),
    },
  };
}

describe("included integration activation defaults", () => {
  it("treats absent new UCSD package state in a legacy profile as first appearance", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "integration-legacy-default-"),
    );
    // Legacy hosts discarded uninstall history. This is intentionally indistinguishable
    // from a never-installed new package; only removals recorded by the new host persist.
    await NodeFSP.writeFile(
      NodePath.join(root, "state.json"),
      JSON.stringify({
        version: 1,
        installed: {},
        removing: {},
      }),
    );
    const registry = new RegistryRuntime(root, [syntheticPackage()]);
    try {
      expect((await registry.list()).integrations[0]).toMatchObject({
        installed: true,
        enabled: true,
      });
    } finally {
      await registry.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("installs only UCSD Assistant on a new profile without sign-in or opt-in abilities", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "integration-defaults-"));
    const otherManifest: IntegrationManifest = {
      ...assistantManifest,
      id: "other-integration",
      provider: "other-provider",
      tools: [],
      skills: [],
    };
    const registry = new RegistryRuntime(root, [
      syntheticPackage(),
      syntheticPackage(otherManifest),
    ]);
    try {
      const { integrations } = await registry.list();
      expect(integrations.find(({ id }) => id === assistantManifest.id)).toMatchObject({
        installed: true,
        enabled: true,
        requiresConnection: false,
        connectionState: "connected",
        capabilities: [
          { id: "public.read", enabled: true, available: true },
          { id: "extra.read", enabled: false, available: false },
        ],
        tools: [{ name: "synthetic.ucsd.read", available: true }],
        skills: [{ name: "synthetic-ucsd-reader", available: true }],
      });
      expect(integrations.find(({ id }) => id === otherManifest.id)).toMatchObject({
        installed: false,
        enabled: false,
      });
      expect(await registry.invokeTool("synthetic.ucsd.read", {})).toEqual({
        source: "synthetic",
        records: [],
      });
      expect(
        JSON.parse(await NodeFSP.readFile(NodePath.join(root, "state.json"), "utf8")),
      ).toMatchObject({
        installed: {
          "ucsd-assistant": { enabled: true, enabledCapabilities: ["public.read"] },
        },
      });
      expect(await NodeFSP.readdir(NodePath.join(root, "installed"))).toEqual(["ucsd-assistant"]);
    } finally {
      await registry.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("activates on first catalog appearance in an existing profile", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "integration-appearance-"));
    const other = syntheticPackage({
      ...assistantManifest,
      id: "other-integration",
      provider: "other-provider",
      tools: [],
      skills: [],
    });
    let registry = new RegistryRuntime(root, [other]);
    try {
      await registry.install(other.manifest.id);
      const previous = (await registry.setEnabled(other.manifest.id, false)).integrations[0];
      await registry.close();
      registry = new RegistryRuntime(root, [other, syntheticPackage()]);
      const { integrations } = await registry.list();
      expect(integrations.find(({ id }) => id === assistantManifest.id)).toMatchObject({
        installed: true,
        enabled: true,
      });
      expect(integrations.find(({ id }) => id === other.manifest.id)).toEqual(previous);
    } finally {
      await registry.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["disable", "disable-capability", "enable-opt-in-capability", "uninstall"] as const)(
    "preserves %s across restart, upgrade, and catalog reintroduction",
    async (choice) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "integration-choice-"));
      let registry = new RegistryRuntime(root, [syntheticPackage()]);
      try {
        await registry.list();
        if (choice === "disable") await registry.setEnabled(assistantManifest.id, false);
        if (choice === "disable-capability") {
          await registry.setCapabilityEnabled(assistantManifest.id, "public.read", false);
        }
        if (choice === "enable-opt-in-capability") {
          await registry.setCapabilityEnabled(assistantManifest.id, "extra.read", true);
        }
        if (choice === "uninstall") await registry.remove(assistantManifest.id);
        await registry.close();

        const abilitiesAvailable = choice === "enable-opt-in-capability";
        const changedAssets = syntheticPackage();
        registry = new RegistryRuntime(root, [
          {
            ...changedAssets,
            bundledFiles: {
              ...changedAssets.bundledFiles,
              "fixture-revision.txt": "Changed assets at the same version.",
            },
          },
        ]);
        const refreshed = (await registry.list()).integrations[0];
        expect(refreshed).toMatchObject({
          installed: choice !== "uninstall",
          enabled: choice === "disable-capability" || abilitiesAvailable,
          tools: [{ available: abilitiesAvailable }],
          skills: [{ available: abilitiesAvailable }],
        });
        if (abilitiesAvailable) {
          expect(refreshed?.capabilities.find(({ id }) => id === "extra.read")).toMatchObject({
            enabled: true,
            available: true,
          });
        }
        await registry.close();

        registry = new RegistryRuntime(root, []);
        expect((await registry.list()).integrations).toEqual([]);
        await registry.close();

        registry = new RegistryRuntime(root, [
          syntheticPackage({ ...assistantManifest, version: "2.0.0" }),
        ]);
        const reintroduced = (await registry.list()).integrations[0];
        expect(reintroduced).toMatchObject({
          version: "2.0.0",
          installed: choice !== "uninstall",
          enabled: choice === "disable-capability" || abilitiesAvailable,
          tools: [{ available: abilitiesAvailable }],
          skills: [{ available: abilitiesAvailable }],
        });
        if (abilitiesAvailable) {
          expect(reintroduced?.capabilities.find(({ id }) => id === "extra.read")).toMatchObject({
            enabled: true,
            available: true,
          });
        }
        if (choice === "uninstall") {
          await expect(
            NodeFSP.access(NodePath.join(root, "installed", assistantManifest.id)),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect((await registry.install(assistantManifest.id)).integrations[0]).toMatchObject({
            installed: true,
            enabled: true,
            tools: [{ available: true }],
          });
          await registry.close();
          registry = new RegistryRuntime(root, [
            syntheticPackage({ ...assistantManifest, version: "2.0.0" }),
          ]);
          expect((await registry.list()).integrations[0]).toMatchObject({
            installed: true,
            enabled: true,
            tools: [{ available: true }],
          });
        }
      } finally {
        await registry.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("remembers an interrupted removal before applying startup defaults", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "integration-removing-"));
    let registry = new RegistryRuntime(root, [syntheticPackage()]);
    try {
      await registry.list();
      await registry.close();
      const statePath = NodePath.join(root, "state.json");
      const previous = JSON.parse(await NodeFSP.readFile(statePath, "utf8"));
      const tombstone = "ucsd-assistant.interrupted";
      await NodeFSP.mkdir(NodePath.join(root, ".trash"), { recursive: true });
      await NodeFSP.writeFile(
        statePath,
        JSON.stringify({
          ...previous,
          removing: { "ucsd-assistant": { version: "1.0.0", tombstone } },
        }),
      );
      await NodeFSP.rename(
        NodePath.join(root, "installed", assistantManifest.id),
        NodePath.join(root, ".trash", tombstone),
      );

      registry = new RegistryRuntime(root, [syntheticPackage()]);
      expect((await registry.list()).integrations[0]).toMatchObject({
        installed: false,
        enabled: false,
      });
      expect(JSON.parse(await NodeFSP.readFile(statePath, "utf8"))).toMatchObject({
        installed: {},
        removing: {},
        uninstalled: ["ucsd-assistant"],
      });
      await registry.close();
      registry = new RegistryRuntime(root, [
        syntheticPackage({ ...assistantManifest, version: "2.0.0" }),
      ]);
      expect((await registry.list()).integrations[0]?.installed).toBe(false);
    } finally {
      await registry.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a completed removal suppressed when tombstone cleanup fails", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "integration-cleanup-"));
    let registry = new RegistryRuntime(root, [syntheticPackage()], undefined, async () => {
      throw new Error("Synthetic cleanup failure.");
    });
    try {
      await registry.list();
      await expect(registry.remove(assistantManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      await registry.close();
      registry = new RegistryRuntime(root, [syntheticPackage()]);
      expect((await registry.list()).integrations[0]?.installed).toBe(false);
      await expect(
        NodeFSP.access(NodePath.join(root, "installed", assistantManifest.id)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await registry.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("retains the uninstall choice if an explicit reinstall rolls back", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "integration-reinstall-"));
    let failSkillSync = false;
    let registry = new RegistryRuntime(root, [syntheticPackage()], {
      reconcileCatalog: async () => undefined,
      sync: async ({ activeSkills }) => {
        if (failSkillSync && activeSkills.length > 0) throw new Error("Synthetic skill failure.");
      },
    });
    try {
      await registry.list();
      await registry.remove(assistantManifest.id);
      failSkillSync = true;
      await expect(registry.install(assistantManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      await registry.close();
      registry = new RegistryRuntime(root, [syntheticPackage()]);
      expect((await registry.list()).integrations[0]?.installed).toBe(false);
    } finally {
      await registry.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves provider readiness and grants when installing by default", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "integration-readiness-"));
    const integration = syntheticPackage();
    const registry = new RegistryRuntime(root, [
      {
        ...integration,
        provider: {
          ...integration.provider!,
          status: async () => ({
            state: "error",
            accountLabel: null,
            grantedCapabilities: [],
            message: "Synthetic source unavailable.",
          }),
        },
      },
    ]);
    try {
      expect((await registry.list()).integrations[0]).toMatchObject({
        installed: true,
        enabled: true,
        connectionState: "error",
        tools: [{ available: false }],
        skills: [{ available: false }],
      });
      await expect(registry.invokeTool("synthetic.ucsd.read", {})).rejects.toMatchObject({
        code: "not_connected",
      });
    } finally {
      await registry.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a failed first installation unavailable and retries on the next startup", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "integration-retry-"));
    const invalid = syntheticPackage();
    let registry = new RegistryRuntime(root, [
      {
        ...invalid,
        bundledFiles: { ...invalid.bundledFiles, ".tritonai-plugin/plugin.json": "{}" },
      },
    ]);
    try {
      await expect(registry.list()).rejects.toThrow();
      expect(registry.isToolAvailableSync("synthetic.ucsd.read")).toBe(false);
      expect(await NodeFSP.readdir(NodePath.join(root, "installed"))).toEqual([]);
      await registry.close();
      registry = new RegistryRuntime(root, [syntheticPackage()]);
      expect((await registry.list()).integrations[0]).toMatchObject({
        installed: true,
        enabled: true,
      });
    } finally {
      await registry.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { uninstalled: "ucsd-assistant" },
    { uninstalled: ["ucsd-assistant", "ucsd-assistant"] },
    { uninstalled: ["../ucsd-assistant"] },
  ])(
    "rejects malformed uninstall preferences before installation: $uninstalled",
    async ({ uninstalled }) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "integration-invalid-"));
      await NodeFSP.writeFile(
        NodePath.join(root, "state.json"),
        JSON.stringify({
          version: 1,
          installed: {},
          uninstalled,
        }),
      );
      const registry = new RegistryRuntime(root, [syntheticPackage()]);
      try {
        await expect(registry.list()).rejects.toThrow(
          "Unsupported integration state version or shape.",
        );
        expect(await NodeFSP.readdir(NodePath.join(root, "installed"))).toEqual([]);
      } finally {
        await registry.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
