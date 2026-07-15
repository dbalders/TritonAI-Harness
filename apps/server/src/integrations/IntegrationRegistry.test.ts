// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off cryptoRandomUUID:off
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
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
import { EmptyIntegrationToolInput } from "./IntegrationTool.ts";

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
      input: EmptyIntegrationToolInput,
      readOnly: true,
      openWorld: false,
    })),
    status: async () => state.status,
    connect: async () => ({
      kind: "device_code",
      flowId: "flow-1",
      verificationUri: "https://fixture.invalid/device",
      verificationUriComplete: null,
      userCode: "ABCD-EFGH",
      message: "Sign in.",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      intervalSeconds: 1,
    }),
    poll: async () => {
      state.credential = "present";
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

function packagedWithSkillContent(
  manifest: IntegrationManifest,
  implementation: IntegrationProvider,
  skill: string,
  content: string,
) {
  const integration = packaged(manifest, implementation);
  return {
    ...integration,
    bundledFiles: {
      ...integration.bundledFiles,
      [`skills/${skill}/SKILL.md`]: content,
    },
  };
}

async function packagedFromRoot(packageRoot: string, implementation: IntegrationProvider) {
  const raw = await NodeFSP.readFile(
    NodePath.join(packageRoot, ".tritonai-plugin", "plugin.json"),
    "utf8",
  );
  return {
    manifest: validateIntegrationManifest(JSON.parse(raw)),
    provider: implementation,
    sourceRoot: packageRoot,
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

      const duplicateToolProvider: IntegrationProvider = {
        ...completeProvider,
        tools: [...completeProvider.tools, completeProvider.tools[0]!],
      };
      expect(
        () =>
          new RegistryRuntime(NodePath.join(root, "duplicate-tool"), [
            packaged(connectedManifest, duplicateToolProvider),
          ]),
      ).toThrow(/tool definitions do not match/u);

      const writableProvider: IntegrationProvider = {
        ...completeProvider,
        tools: completeProvider.tools.map((tool, index) =>
          index === 0 ? { ...tool, readOnly: false } : tool,
        ),
      };
      const writeManifest: IntegrationManifest = {
        ...connectedManifest,
        id: "test-cloud-records-write",
        name: "Test Cloud Records Write",
        capabilities: [
          ...connectedManifest.capabilities,
          { id: "records.write", displayName: "Write records", description: "Write records." },
        ],
        tools: connectedManifest.tools.map((tool, index) =>
          index === 0 ? { ...tool, capability: "records.write" } : tool,
        ),
      };
      state.status = {
        state: "connected",
        accountLabel: "Write Fixture",
        grantedCapabilities: ["records.write"],
        message: null,
      };
      const writeRegistry = new RegistryRuntime(NodePath.join(root, "write-runtime"), [
        packaged(writeManifest, writableProvider),
      ]);
      await writeRegistry.install(writeManifest.id);
      await expect(writeRegistry.invokeTool("test.records.list", {})).resolves.toMatchObject({
        toolName: "test.records.list",
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("supports stateless tool providers without presenting connection controls", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-stateless-tool-"));
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: null,
        grantedCapabilities: ["fixture.read"],
        message: "No connection required.",
      },
      credential: null,
      disconnectFails: false,
    };
    const connectedProvider = provider("test-fixture-provider", state);
    const statelessProvider: IntegrationProvider = {
      id: connectedProvider.id,
      tools: connectedProvider.tools,
      status: connectedProvider.status,
      invoke: connectedProvider.invoke,
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(fixtureManifest, statelessProvider)]);
      const installed = await registry.install(fixtureManifest.id);
      expect(installed.integrations[0]).toMatchObject({
        installed: true,
        requiresConnection: false,
        connectionState: "connected",
      });
      await expect(registry.invokeTool("test.fixture.read", {})).resolves.toMatchObject({
        toolName: "test.fixture.read",
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a faulted stateless provider after its work drains and the plugin is disabled", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-stateless-provider-recovery-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: null,
        grantedCapabilities: ["fixture.read"],
        message: "No connection required.",
      },
      credential: null,
      disconnectFails: false,
    };
    let releaseFirstInvocation!: () => void;
    const firstInvocationGate = new Promise<void>((resolve) => {
      releaseFirstInvocation = resolve;
    });
    let markFirstInvocationStarted!: () => void;
    const firstInvocationStarted = new Promise<void>((resolve) => {
      markFirstInvocationStarted = resolve;
    });
    let invocationCount = 0;
    const baseProvider = provider("test-fixture-provider", state);
    const statelessProvider: IntegrationProvider = {
      id: baseProvider.id,
      tools: baseProvider.tools,
      status: baseProvider.status,
      invoke: async () => {
        invocationCount += 1;
        if (invocationCount === 1) {
          markFirstInvocationStarted();
          await firstInvocationGate;
        }
        return { records: [] };
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(fixtureManifest, statelessProvider)],
        undefined,
        undefined,
        { providerOperationTimeoutMs: 20 },
      );
      await registry.install(fixtureManifest.id);
      const invocation = registry.invokeTool("test.fixture.read", {});
      const invocationRejected = expect(invocation).rejects.toThrow(/revoked|disabled/u);
      await firstInvocationStarted;

      await expect(registry.setEnabled(fixtureManifest.id, false)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect(registry.isToolAvailableSync("test.fixture.read")).toBe(false);

      releaseFirstInvocation();
      await invocationRejected;
      await registry.setEnabled(fixtureManifest.id, false);
      await registry.setEnabled(fixtureManifest.id, true);
      await expect(registry.invokeTool("test.fixture.read", {})).resolves.toEqual({ records: [] });
    } finally {
      releaseFirstInvocation?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects partial provider lifecycles and ambiguous package sources", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-provider-shape-"));
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
    const complete = provider("test-fixture-provider", state);
    const partial: IntegrationProvider = {
      id: complete.id,
      tools: complete.tools,
      status: complete.status,
      connect: async (capabilities) => complete.connect!(capabilities),
      invoke: complete.invoke,
    };
    try {
      expect(
        () =>
          new RegistryRuntime(NodePath.join(root, "partial"), [packaged(fixtureManifest, partial)]),
      ).toThrow(/must implement connect and disconnect together/u);

      const { poll: _poll, ...deviceWithoutPoll } = complete;
      const noPollRegistry = new RegistryRuntime(NodePath.join(root, "no-poll"), [
        packaged(fixtureManifest, deviceWithoutPoll),
      ]);
      await noPollRegistry.install(fixtureManifest.id);
      await expect(noPollRegistry.connect(fixtureManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
        message: expect.stringContaining("authorization could not start"),
      });

      const ambiguous = {
        ...packaged(fixtureManifest, complete),
        sourceRoot: NodePath.join(root, "package"),
      };
      expect(() => new RegistryRuntime(NodePath.join(root, "ambiguous"), [ambiguous])).toThrow(
        /cannot declare two package sources/u,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("decodes provider input before invocation and propagates caller cancellation", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-tool-input-"));
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
    const baseProvider = provider("test-fixture-provider", state);
    let providerInvocations = 0;
    let providerObservedAbort = false;
    let receivedInput: unknown;
    let markInvocationStarted!: () => void;
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve;
    });
    const schemaProvider: IntegrationProvider = {
      ...baseProvider,
      tools: baseProvider.tools.map((tool) => ({
        ...tool,
        input: Schema.Struct({ query: Schema.String }),
      })),
      invoke: async (_name, input, context) => {
        providerInvocations += 1;
        receivedInput = input;
        if (!context) throw new Error("Invocation context is required.");
        markInvocationStarted();
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            providerObservedAbort = context.signal.aborted;
            reject(
              context.signal.reason instanceof Error
                ? context.signal.reason
                : new Error("Provider invocation cancelled."),
            );
          };
          if (context.signal.aborted) onAbort();
          else context.signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(fixtureManifest, schemaProvider)]);
      await registry.install(fixtureManifest.id);
      await expect(registry.invokeTool("test.fixture.read", { query: 42 })).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(providerInvocations).toBe(0);

      const controller = new AbortController();
      const invocation = registry.invokeTool(
        "test.fixture.read",
        { query: "bounded" },
        { signal: controller.signal },
      );
      const cancelled = expect(invocation).rejects.toThrow("Caller cancelled.");
      await invocationStarted;
      controller.abort(new Error("Caller cancelled."));
      await cancelled;
      expect(providerInvocations).toBe(1);
      expect(receivedInput).toEqual({ query: "bounded" });
      expect(providerObservedAbort).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed bundled skill frontmatter before installation", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-skill-contract-"));
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
    try {
      const malformedContents = [
        "---\nname: wrong-skill\ndescription: Wrong identity.\n---\n",
        "---\nname: fixture-reader\n---\n",
        "---\nname: fixture-reader\nname: duplicate\ndescription: Duplicate name.\n---\n",
        `---\nname: fixture-reader\ndescription: ${"x".repeat(1_025)}\n---\n`,
      ];
      for (const [index, content] of malformedContents.entries()) {
        const malformed = packagedWithSkillContent(
          fixtureManifest,
          provider("test-fixture-provider", state),
          "fixture-reader",
          content,
        );
        const registry = new RegistryRuntime(NodePath.join(root, String(index)), [malformed]);
        await expect(registry.install(fixtureManifest.id)).rejects.toMatchObject({
          code: "operation_failed",
        });
        expect((await registry.list()).integrations[0]?.installed).toBe(false);
        await registry.close();
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("deactivates incompatible packages and reconciles catalog version drift", async () => {
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
      credential: "present",
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
      await expect(incompatibleRegistry.connect(connectedManifest.id)).rejects.toMatchObject({
        code: "incompatible",
      });

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
      expect(mismatchSummary).toMatchObject({ compatible: true, installed: true });
      expect(mismatchSummary.compatibilityMessage).toBeNull();
      expect(mismatchSummary.tools[0]?.available).toBe(true);
      await expect(mismatchRegistry.install(connectedManifest.id)).resolves.toBeDefined();
      await expect(mismatchRegistry.invokeTool("test.records.list", {})).resolves.toBeDefined();
      await mismatchRegistry.setEnabled(connectedManifest.id, false);
      await expect(mismatchRegistry.setEnabled(connectedManifest.id, true)).resolves.toBeDefined();
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
        state.status = {
          state: "error",
          accountLabel: null,
          grantedCapabilities: [],
          message: "Provider rejected the connection.",
        };
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
      await expect(registry.connect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
        message: "Test Cloud Records authorization could not start. Try again.",
      });
      expect((await registry.snapshot()).integrations[0]).toMatchObject({
        connectionState: "error",
        statusMessage: "Provider rejected the connection.",
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
      await expect(registry.connect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
        message: "Open the provider settings and try again.",
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes cached availability for a non-terminal connect result", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-connect-summary-refresh-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    const baseProvider = provider("test-connected-provider", state);
    const connectingProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (...args) => {
        state.status = {
          state: "connecting",
          accountLabel: null,
          grantedCapabilities: [],
          message: "Waiting for authorization.",
        };
        return baseProvider.connect!(...args);
      },
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, connectingProvider)]);
      await registry.install(connectedManifest.id);
      expect(registry.isToolAvailableSync("test.records.list")).toBe(true);

      await expect(registry.connect(connectedManifest.id)).resolves.toMatchObject({
        kind: "device_code",
      });
      expect((await registry.snapshot()).integrations[0]).toMatchObject({
        connectionState: "connecting",
        statusMessage: "Waiting for authorization.",
      });
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      expect(registry.isSkillAvailableSync("test-records")).toBe(false);
      await registry.close();
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
      const baseConnectedProvider = provider("test-connected-provider", connectedState);
      let requestedCapabilities: ReadonlyArray<string> = [];
      const connectedProvider: IntegrationProvider = {
        ...baseConnectedProvider,
        connect: async (capabilities) => {
          requestedCapabilities = capabilities;
          return baseConnectedProvider.connect!(capabilities);
        },
      };
      const fixtureProvider = provider("test-fixture-provider", fixtureState);
      const registry = new RegistryRuntime(root, [
        packaged(connectedManifest, connectedProvider),
        packaged(fixtureManifest, fixtureProvider),
      ]);

      expect((await registry.list()).integrations).toHaveLength(2);
      await registry.install(connectedManifest.id);
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      const flow = await registry.connect(connectedManifest.id);
      expect(requestedCapabilities).toEqual(["records.read", "events.read"]);
      const result = await registry.poll(connectedManifest.id, flow.flowId);
      expect(
        result.integration.tools.find(({ name }) => name === "test.records.list")?.available,
      ).toBe(true);
      expect(
        result.integration.tools.find(({ name }) => name === "test.events.list")?.available,
      ).toBe(false);
      expect(result.integration.skills[0]?.available).toBe(true);
      expect(JSON.stringify(result)).not.toContain("present");
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
        [await packagedFromRoot(packageRoot, provider("test-fixture-provider", state))],
        new CodexIntegrationSkillMaterializer([codexHome]),
      );
      expect(registry.toolDefinitions().map(({ name }) => name)).toEqual(["test.fixture.read"]);
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

  it("persists per-skill switches and revokes only the selected skill", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-skill-enablement-"),
    );
    const codexHome = NodePath.join(root, "codex");
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
    const integration = packaged(fixtureManifest, provider("test-fixture-provider", state));
    try {
      const registry = new RegistryRuntime(
        NodePath.join(root, "runtime"),
        [integration],
        new CodexIntegrationSkillMaterializer([codexHome]),
      );
      await registry.install(fixtureManifest.id);
      const materializedSkill = NodePath.join(codexHome, "skills", "fixture-reader", "SKILL.md");
      expect(await NodeFSP.readFile(materializedSkill, "utf8")).toContain("fixture-reader");
      expect((await registry.list()).integrations[0]?.skills[0]).toMatchObject({
        enabled: true,
        available: true,
      });

      const reservation = registry.reserveSkillsSync(["fixture-reader"]);
      expect(reservation).not.toBeNull();
      let disableCompleted = false;
      const disabling = registry.setSkillEnabled(fixtureManifest.id, "fixture-reader", false);
      void disabling.then(() => {
        disableCompleted = true;
      });
      expect(registry.isSkillAvailableSync("fixture-reader")).toBe(false);
      expect(registry.isToolAvailableSync("test.fixture.read")).toBe(true);
      expect(registry.reserveSkillsSync(["fixture-reader"])).toBeNull();
      await Promise.resolve();
      expect(disableCompleted).toBe(false);
      reservation?.release();

      const disabled = await disabling;
      expect(disabled.integrations[0]?.skills[0]).toMatchObject({
        enabled: false,
        available: false,
      });
      await expect(NodeFSP.access(materializedSkill)).rejects.toMatchObject({ code: "ENOENT" });

      const restarted = new RegistryRuntime(
        NodePath.join(root, "runtime"),
        [integration],
        new CodexIntegrationSkillMaterializer([codexHome]),
      );
      expect((await restarted.list()).integrations[0]?.skills[0]).toMatchObject({
        enabled: false,
        available: false,
      });
      await restarted.setSkillEnabled(fixtureManifest.id, "fixture-reader", true);
      expect(await NodeFSP.readFile(materializedSkill, "utf8")).toContain("fixture-reader");
      expect(restarted.isToolAvailableSync("test.fixture.read")).toBe(true);
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
      const registry = new RegistryRuntime(NodePath.join(root, "runtime"), [
        await packagedFromRoot(packageRoot, provider("test-fixture-provider", state)),
      ]);
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
      const registry = new RegistryRuntime(NodePath.join(root, "runtime"), [
        await packagedFromRoot(packageRoot, provider("test-fixture-provider", state)),
      ]);
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
      credential: "present",
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
      expect(state.credential).toBe("present");
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
          state.credential = "present";
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

  it("revokes tool status waiters before provider lifecycle work starts", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-provider-status-waiter-"),
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
    let delayStatus = false;
    let releaseStatus!: () => void;
    let markStatusStarted!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    const baseProvider = provider("test-connected-provider", state);
    const delayedProvider: IntegrationProvider = {
      ...baseProvider,
      status: async () => {
        const status = state.status;
        if (delayStatus) {
          delayStatus = false;
          markStatusStarted();
          await statusGate;
        }
        return status;
      },
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, delayedProvider)]);
      await registry.install(connectedManifest.id);
      delayStatus = true;

      const invocation = registry.invokeTool("test.records.list", {});
      await statusStarted;
      await expect(registry.connect(connectedManifest.id)).resolves.toMatchObject({
        kind: "device_code",
      });
      releaseStatus();

      await expect(invocation).rejects.toMatchObject({ code: "disabled" });
      await registry.close();
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

  it("waits for aborted tool cleanup before disconnecting provider credentials", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-tool-drain-"));
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
    let markAbortObserved!: () => void;
    let releaseCleanup!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const abortObserved = new Promise<void>((resolve) => {
      markAbortObserved = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupComplete = false;
    let disconnectCalls = 0;
    const baseProvider = provider("test-connected-provider", state);
    const delayedProvider: IntegrationProvider = {
      ...baseProvider,
      invoke: async (_toolName, _input, context) => {
        markToolStarted();
        return new Promise((_resolve, reject) => {
          context?.signal.addEventListener(
            "abort",
            () => {
              markAbortObserved();
              void cleanupGate.then(() => {
                cleanupComplete = true;
                reject(new Error("fixture invocation cleanup completed"));
              });
            },
            { once: true },
          );
        });
      },
      disconnect: async (context) => {
        disconnectCalls += 1;
        expect(cleanupComplete).toBe(true);
        return baseProvider.disconnect!(context);
      },
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, delayedProvider)]);
      await registry.install(connectedManifest.id);
      const invocation = registry.invokeTool("test.records.list", {});
      await toolStarted;

      const disconnecting = registry.disconnect(connectedManifest.id);
      await abortObserved;
      await Promise.resolve();
      expect(disconnectCalls).toBe(0);
      expect(state.credential).toBe("present");

      releaseCleanup();
      await expect(invocation).rejects.toThrow(/revoked/u);
      await disconnecting;
      expect(disconnectCalls).toBe(1);
      expect(state.credential).toBeNull();
    } finally {
      releaseCleanup?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("faults instead of disconnecting when aborted tool work misses the revocation deadline", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-tool-drain-timeout-"),
    );
    const codexHome = NodePath.join(root, "codex");
    const materializedSkill = NodePath.join(codexHome, "skills", "test-records", "SKILL.md");
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
    let releaseTool!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let disconnectCalls = 0;
    const baseProvider = provider("test-connected-provider", state);
    const stalledProvider: IntegrationProvider = {
      ...baseProvider,
      invoke: async () => {
        markToolStarted();
        await toolGate;
        return { records: [] };
      },
      disconnect: async (context) => {
        disconnectCalls += 1;
        return baseProvider.disconnect!(context);
      },
      close: async () => {
        releaseTool();
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, stalledProvider)],
        new CodexIntegrationSkillMaterializer([codexHome]),
        undefined,
        { providerStatusTimeoutMs: 20, providerOperationTimeoutMs: 20 },
      );
      await registry.install(connectedManifest.id);
      expect(await NodeFSP.readFile(materializedSkill, "utf8")).toContain("test-records");
      const invocation = registry.invokeTool("test.records.list", {});
      const invocationRejected = expect(invocation).rejects.toThrow(/revoked|disabled/u);
      await toolStarted;

      await expect(registry.disconnect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect(disconnectCalls).toBe(0);
      expect(state.credential).toBe("present");
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      await registry.close();
      await invocationRejected;
      await expect(NodeFSP.access(materializedSkill)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseTool?.();
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

  it("abandons revocation when an active skill submission does not settle", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-skill-reservation-timeout-"),
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
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, provider("test-connected-provider", state))],
        undefined,
        undefined,
        { providerOperationTimeoutMs: 20 },
      );
      await registry.install(connectedManifest.id);
      const reservation = registry.reserveSkillsSync(["test-records"]);
      expect(reservation).not.toBeNull();

      await expect(registry.setEnabled(connectedManifest.id, false)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect((await registry.snapshot()).integrations[0]).toMatchObject({ enabled: true });
      expect(registry.isSkillAvailableSync("test-records")).toBe(true);

      reservation!.release();
      await registry.close();
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
      const invocationRejected = expect(invocation).rejects.toThrow(/revoked/u);
      await statusStarted;
      const disabling = registry.setEnabled(connectedManifest.id, false);
      releaseStatus();

      await invocationRejected;
      await disabling;
      expect(providerInvoked).toBe(false);
    } finally {
      releaseStatus?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reuse a stale connected status after disconnect", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-status-disconnect-"),
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
    let holdNextStatus = false;
    let markStatusStarted!: () => void;
    let releaseStatus!: () => void;
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    try {
      const baseProvider = provider("test-connected-provider", state);
      const delayedProvider: IntegrationProvider = {
        ...baseProvider,
        status: async () => {
          const captured = state.status;
          if (holdNextStatus) {
            holdNextStatus = false;
            markStatusStarted();
            await statusGate;
          }
          return captured;
        },
      };
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, delayedProvider)]);
      await registry.install(connectedManifest.id);
      holdNextStatus = true;

      const invocation = registry.invokeTool("test.records.list", {});
      const invocationRejected = expect(invocation).rejects.toThrow(/revoked/u);
      await statusStarted;
      const result = await registry.disconnect(connectedManifest.id);

      await invocationRejected;
      expect(result.integrations[0]).toMatchObject({
        connectionState: "not_connected",
        tools: [
          expect.objectContaining({ name: "test.records.list", available: false }),
          expect.objectContaining({ name: "test.events.list", available: false }),
        ],
      });
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);

      releaseStatus();
      await Promise.resolve();
      expect((await registry.snapshot()).integrations[0]).toMatchObject({
        connectionState: "not_connected",
      });
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
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
      reconcileCatalog: async () => undefined,
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

  it("reports a failed skill-state rollback without claiming the old state was restored", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-skill-rollback-failure-"),
    );
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
    let sabotageNextSync = false;
    const materializer: IntegrationSkillMaterializer = {
      reconcileCatalog: async () => undefined,
      sync: async () => {
        if (!sabotageNextSync) return;
        sabotageNextSync = false;
        const statePath = NodePath.join(root, "state.json");
        await NodeFSP.rm(statePath, { force: true });
        await NodeFSP.mkdir(statePath);
        throw new Error("Skill materialization failed.");
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(fixtureManifest, provider("test-fixture-provider", state))],
        materializer,
      );
      await registry.install(fixtureManifest.id);
      sabotageNextSync = true;

      await expect(
        registry.setSkillEnabled(fixtureManifest.id, "fixture-reader", false),
      ).rejects.toMatchObject({
        code: "operation_failed",
        message: expect.stringContaining("rollback could not be persisted"),
      });
      expect((await registry.snapshot()).integrations[0]?.skills[0]).toMatchObject({
        enabled: false,
        available: false,
      });
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

  it("prunes orphaned install trees while preserving stateful retired packages", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-orphan-package-"));
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
    const integration = packaged(fixtureManifest, provider("test-fixture-provider", state));
    const retiredRoot = NodePath.join(root, "installed", "retired-plugin", "1.0.0");
    try {
      const initial = new RegistryRuntime(root, [integration]);
      await initial.install(fixtureManifest.id);
      await NodeFSP.mkdir(retiredRoot, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(retiredRoot, "retired.txt"), "preserve me");
      await NodeFSP.writeFile(
        NodePath.join(root, "state.json"),
        `${JSON.stringify({
          version: 1,
          installed: { "retired-plugin": { version: "1.0.0", enabled: false } },
          removing: {},
        })}\n`,
      );

      const restarted = new RegistryRuntime(root, [integration]);
      expect((await restarted.list()).integrations[0]?.installed).toBe(false);
      await expect(
        NodeFSP.access(NodePath.join(root, "installed", fixtureManifest.id)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await NodeFSP.readFile(NodePath.join(retiredRoot, "retired.txt"), "utf8")).toBe(
        "preserve me",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles installed packages to a new catalog version without changing user state", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-upgrade-package-"));
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
    const implementation = provider("test-fixture-provider", state);
    const versionTwo: IntegrationManifest = { ...fixtureManifest, version: "2.0.0" };
    try {
      const initial = new RegistryRuntime(root, [packaged(fixtureManifest, implementation)]);
      await initial.install(fixtureManifest.id);
      await initial.setSkillEnabled(fixtureManifest.id, "fixture-reader", false);
      await initial.setEnabled(fixtureManifest.id, false);

      const restarted = new RegistryRuntime(root, [packaged(versionTwo, implementation)]);
      const summary = (await restarted.list()).integrations[0];
      expect(summary).toMatchObject({
        version: "2.0.0",
        installed: true,
        enabled: false,
      });
      expect(summary?.skills[0]).toMatchObject({ enabled: false, available: false });
      expect(state.credential).toBe("present");
      expect(await NodeFSP.readdir(NodePath.join(root, "installed", fixtureManifest.id))).toEqual([
        "2.0.0",
      ]);
      await expect(
        NodeFSP.access(
          NodePath.join(root, "installed", fixtureManifest.id, fixtureManifest.version),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const persisted = JSON.parse(
        await NodeFSP.readFile(NodePath.join(root, "state.json"), "utf8"),
      );
      expect(persisted.installed[fixtureManifest.id]).toEqual({
        version: "2.0.0",
        enabled: false,
        disabledSkills: ["fixture-reader"],
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles changed package assets without requiring a version bump", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-drift-package-"));
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
    const implementation = provider("test-fixture-provider", state);
    const firstSkill = "---\nname: fixture-reader\ndescription: First revision.\n---\n";
    const secondSkill = "---\nname: fixture-reader\ndescription: Second revision.\n---\n";
    try {
      const initial = new RegistryRuntime(root, [
        packagedWithSkillContent(fixtureManifest, implementation, "fixture-reader", firstSkill),
      ]);
      await initial.install(fixtureManifest.id);

      const restarted = new RegistryRuntime(root, [
        packagedWithSkillContent(fixtureManifest, implementation, "fixture-reader", secondSkill),
      ]);
      expect((await restarted.list()).integrations[0]).toMatchObject({
        installed: true,
        enabled: true,
      });
      expect(
        await NodeFSP.readFile(
          NodePath.join(
            root,
            "installed",
            fixtureManifest.id,
            fixtureManifest.version,
            "skills",
            "fixture-reader",
            "SKILL.md",
          ),
          "utf8",
        ),
      ).toBe(secondSkill);
      expect(state.credential).toBe("present");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("uses prefix-free package digests when reconciling binary asset changes", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-prefix-free-package-digest-"),
    );
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
    const implementation = provider("test-fixture-provider", state);
    const basePackage = packaged(fixtureManifest, implementation);
    try {
      const initial = new RegistryRuntime(root, [
        {
          ...basePackage,
          bundledFiles: {
            ...basePackage.bundledFiles,
            a: "X\0file\0b\0Y",
          },
        },
      ]);
      await initial.install(fixtureManifest.id);

      const restarted = new RegistryRuntime(root, [
        {
          ...basePackage,
          bundledFiles: {
            ...basePackage.bundledFiles,
            a: "X",
            b: "Y",
          },
        },
      ]);
      await restarted.list();
      const packageRoot = NodePath.join(
        root,
        "installed",
        fixtureManifest.id,
        fixtureManifest.version,
      );
      expect(await NodeFSP.readFile(NodePath.join(packageRoot, "a"), "utf8")).toBe("X");
      expect(await NodeFSP.readFile(NodePath.join(packageRoot, "b"), "utf8")).toBe("Y");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("replaces a symlinked installed package root during startup reconciliation", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-installed-root-symlink-"),
    );
    const externalRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-external-installed-package-"),
    );
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
    const implementation = provider("test-fixture-provider", state);
    const integration = packaged(fixtureManifest, implementation);
    try {
      const initial = new RegistryRuntime(root, [integration]);
      await initial.install(fixtureManifest.id);
      const installedRoot = NodePath.join(root, "installed", fixtureManifest.id);
      await NodeFSP.cp(installedRoot, externalRoot, { recursive: true });
      await NodeFSP.rm(installedRoot, { recursive: true, force: true });
      await NodeFSP.symlink(externalRoot, installedRoot, "dir");

      const restarted = new RegistryRuntime(root, [integration]);
      expect((await restarted.list()).integrations[0]).toMatchObject({
        installed: true,
        enabled: true,
      });
      const reconciledRoot = await NodeFSP.lstat(installedRoot);
      expect(reconciledRoot.isDirectory()).toBe(true);
      expect(reconciledRoot.isSymbolicLink()).toBe(false);
      await NodeFSP.writeFile(
        NodePath.join(
          externalRoot,
          fixtureManifest.version,
          "skills",
          "fixture-reader",
          "SKILL.md",
        ),
        "external mutation",
      );
      expect(
        await NodeFSP.readFile(
          NodePath.join(
            installedRoot,
            fixtureManifest.version,
            "skills",
            "fixture-reader",
            "SKILL.md",
          ),
          "utf8",
        ),
      ).not.toBe("external mutation");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
      await NodeFSP.rm(externalRoot, { recursive: true, force: true });
    }
  });

  it("replaces an installed package root symlinked to a file without traversing it", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-installed-root-file-symlink-"),
    );
    const externalFile = NodePath.join(root, "external-file");
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
    const integration = packaged(fixtureManifest, provider("test-fixture-provider", state));
    try {
      const initial = new RegistryRuntime(root, [integration]);
      await initial.install(fixtureManifest.id);
      const installedRoot = NodePath.join(root, "installed", fixtureManifest.id);
      await NodeFSP.rm(installedRoot, { recursive: true, force: true });
      await NodeFSP.writeFile(externalFile, "outside package content");
      await NodeFSP.symlink(externalFile, installedRoot, "file");

      const restarted = new RegistryRuntime(root, [integration]);
      expect((await restarted.list()).integrations[0]).toMatchObject({
        installed: true,
        enabled: true,
      });
      expect((await NodeFSP.lstat(installedRoot)).isSymbolicLink()).toBe(false);
      expect(await NodeFSP.readFile(externalFile, "utf8")).toBe("outside package content");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("replaces a symlinked installed directory without touching its external target", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-installed-directory-symlink-"),
    );
    const externalRoot = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-external-installed-directory-"),
    );
    const externalFile = NodePath.join(externalRoot, "must-survive.txt");
    try {
      await NodeFSP.writeFile(externalFile, "outside integration state");
      await NodeFSP.symlink(externalRoot, NodePath.join(root, "installed"), "dir");

      const registry = new RegistryRuntime(root, []);
      expect((await registry.list()).integrations).toEqual([]);
      const installedRoot = await NodeFSP.lstat(NodePath.join(root, "installed"));
      expect(installedRoot.isDirectory()).toBe(true);
      expect(installedRoot.isSymbolicLink()).toBe(false);
      expect(await NodeFSP.readFile(externalFile, "utf8")).toBe("outside integration state");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
      await NodeFSP.rm(externalRoot, { recursive: true, force: true });
    }
  });

  it("treats prototype-like integration IDs as ordinary state keys", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-own-key-"));
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
    const constructorManifest: IntegrationManifest = {
      ...fixtureManifest,
      id: "constructor",
      name: "Constructor Fixture",
    };
    let reconciledCatalog = new Set<string>();
    const materializer: IntegrationSkillMaterializer = {
      sync: async () => undefined,
      reconcileCatalog: async (ids) => {
        reconciledCatalog = new Set(ids);
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(constructorManifest, provider("test-fixture-provider", state))],
        materializer,
      );
      expect((await registry.list()).integrations[0]?.installed).toBe(false);
      expect(reconciledCatalog).toEqual(new Set(["constructor"]));
      expect((await registry.install("constructor")).integrations[0]?.installed).toBe(true);
      expect((await registry.remove("constructor")).integrations[0]?.installed).toBe(false);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("bounds provider status checks and prepares skills from initialized summaries", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-status-timeout-"));
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
    const baseProvider = provider("test-fixture-provider", state);
    let statusCalls = 0;
    const countingProvider: IntegrationProvider = {
      ...baseProvider,
      status: async (context) => {
        statusCalls += 1;
        expect(context?.signal).toBeInstanceOf(AbortSignal);
        return state.status;
      },
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(fixtureManifest, countingProvider)]);
      await registry.install(fixtureManifest.id);
      const callsBeforePreparation = statusCalls;
      await registry.snapshot();
      expect(statusCalls).toBe(callsBeforePreparation);
      const runtime = await registry.prepareSkillRuntime();
      expect(runtime).not.toBeNull();
      expect(statusCalls).toBe(callsBeforePreparation);
      if (runtime) await registry.releaseSkillRuntime(runtime.root);
      await registry.close();

      const signals: Array<AbortSignal> = [];
      let hangingStatusCalls = 0;
      const hangingProvider: IntegrationProvider = {
        ...baseProvider,
        status: async (context) => {
          hangingStatusCalls += 1;
          if (context) signals.push(context.signal);
          return new Promise<IntegrationProviderStatus>(() => undefined);
        },
      };
      const restarted = new RegistryRuntime(
        root,
        [packaged(fixtureManifest, hangingProvider)],
        undefined,
        undefined,
        { providerStatusTimeoutMs: 20 },
      );
      const startedAt = Date.now();
      const summary = (await restarted.list()).integrations[0];
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(summary).toMatchObject({
        connectionState: "error",
        statusMessage: "The integration provider timed out while reporting its status.",
      });
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      await restarted.list();
      await restarted.list();
      expect(hangingStatusCalls).toBe(1);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes valid provider status and isolates malformed status from other plugins", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-status-contract-"));
    const malformedState: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Malformed",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    const healthyState: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "  Fixture User  ",
        grantedCapabilities: [" fixture.read ", "fixture.read"],
        message: "  Ready  ",
      },
      credential: "present",
      disconnectFails: false,
    };
    const malformedProvider: IntegrationProvider = {
      ...provider("test-connected-provider", malformedState),
      status: async () =>
        ({
          state: "connected",
          accountLabel: "Malformed",
          grantedCapabilities: null,
          message: null,
        }) as unknown as IntegrationProviderStatus,
    };
    try {
      const registry = new RegistryRuntime(root, [
        packaged(connectedManifest, malformedProvider),
        packaged(fixtureManifest, provider("test-fixture-provider", healthyState)),
      ]);
      await registry.install(connectedManifest.id);
      await registry.install(fixtureManifest.id);
      const result = await registry.list();
      expect(result.integrations.find(({ id }) => id === connectedManifest.id)).toMatchObject({
        connectionState: "error",
        accountLabel: null,
        statusMessage: "The integration provider could not report its status.",
      });
      expect(result.integrations.find(({ id }) => id === fixtureManifest.id)).toMatchObject({
        connectionState: "connected",
        accountLabel: "Fixture User",
        statusMessage: "Ready",
        capabilities: [{ id: "fixture.read", granted: true }],
      });
      await registry.close();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed persisted state before mutating package trees", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-state-decode-"));
    const marker = NodePath.join(root, "installed", fixtureManifest.id, "marker.txt");
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
      await NodeFSP.mkdir(NodePath.dirname(marker), { recursive: true });
      await NodeFSP.writeFile(marker, "preserve me");
      await NodeFSP.writeFile(
        NodePath.join(root, "state.json"),
        JSON.stringify({
          version: 1,
          installed: {
            [fixtureManifest.id]: {
              version: "1.0.0-01",
              enabled: true,
            },
          },
          removing: {},
        }),
      );
      const registry = new RegistryRuntime(root, [
        packaged(fixtureManifest, provider("test-fixture-provider", state)),
      ]);
      await expect(registry.list()).rejects.toThrow(/Invalid installed integration state/u);
      expect(await NodeFSP.readFile(marker, "utf8")).toBe("preserve me");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a dangling installed-root symlink into a real package tree", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-dangling-root-"));
    const installedRoot = NodePath.join(root, "installed", fixtureManifest.id);
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
      await NodeFSP.mkdir(NodePath.dirname(installedRoot), { recursive: true });
      await NodeFSP.symlink(NodePath.join(root, "missing-package"), installedRoot);
      await NodeFSP.writeFile(
        NodePath.join(root, "state.json"),
        JSON.stringify({
          version: 1,
          installed: {
            [fixtureManifest.id]: { version: fixtureManifest.version, enabled: true },
          },
          removing: {},
        }),
      );
      const registry = new RegistryRuntime(root, [
        packaged(fixtureManifest, provider("test-fixture-provider", state)),
      ]);
      expect((await registry.list()).integrations[0]).toMatchObject({
        installed: true,
        enabled: true,
        connectionState: "connected",
      });
      const reconciled = await NodeFSP.lstat(installedRoot);
      expect(reconciled.isDirectory()).toBe(true);
      expect(reconciled.isSymbolicLink()).toBe(false);
      await registry.close();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("faults a provider after a lifecycle timeout and closes without overlapping calls", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-lifecycle-timeout-"),
    );
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
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    let connectCalls = 0;
    let closeCalls = 0;
    const signals: Array<AbortSignal> = [];
    const baseProvider = provider("test-connected-provider", state);
    const hangingProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (capabilities, context) => {
        connectCalls += 1;
        if (context) signals.push(context.signal);
        await connectGate;
        return baseProvider.connect!(capabilities, context);
      },
      close: async () => {
        closeCalls += 1;
        releaseConnect();
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, hangingProvider)],
        undefined,
        undefined,
        { providerStatusTimeoutMs: 20, providerOperationTimeoutMs: 20 },
      );
      await registry.install(connectedManifest.id);
      state.status = {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["records.read"],
        message: null,
      };
      await registry.list();
      expect(registry.isToolAvailableSync("test.records.list")).toBe(true);
      expect(registry.isSkillAvailableSync("test-records")).toBe(true);
      await expect(registry.connect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      await expect(registry.connect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect(connectCalls).toBe(1);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      expect(registry.isSkillAvailableSync("test-records")).toBe(false);
      expect(registry.getAvailableSkillsSync()).toEqual([]);
      expect((await registry.snapshot()).integrations[0]?.tools[0]?.available).toBe(false);
      const startedAt = Date.now();
      await registry.close();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(closeCalls).toBe(1);
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      await expect(registry.list()).rejects.toMatchObject({ code: "disabled" });
    } finally {
      releaseConnect();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("drains admitted tools and skills before connect and poll mutate credentials", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-lifecycle-admission-drain-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    let markInvocationStarted!: () => void;
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve;
    });
    let releaseInvocationCleanup!: () => void;
    const invocationCleanup = new Promise<void>((resolve) => {
      releaseInvocationCleanup = resolve;
    });
    let connectCalls = 0;
    let pollCalls = 0;
    const baseProvider = provider("test-connected-provider", state);
    const drainingProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (...args) => {
        connectCalls += 1;
        return baseProvider.connect!(...args);
      },
      poll: async (...args) => {
        pollCalls += 1;
        return baseProvider.poll!(...args);
      },
      invoke: async (_name, _input, context) => {
        if (!context) throw new Error("Invocation context is required.");
        markInvocationStarted();
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        await invocationCleanup;
        return { records: [] };
      },
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, drainingProvider)]);
      await registry.install(connectedManifest.id);
      const invocation = registry.invokeTool("test.records.list", {});
      await invocationStarted;

      const connecting = registry.connect(connectedManifest.id);
      await Promise.resolve();
      expect(connectCalls).toBe(0);
      expect(registry.getAvailableSkillsSync()).toEqual([]);
      releaseInvocationCleanup();
      await expect(invocation).rejects.toMatchObject({ code: "disabled" });
      await connecting;
      expect(connectCalls).toBe(1);

      const reservation = registry.reserveSkillsSync(["test-records"]);
      expect(reservation).not.toBeNull();
      const polling = registry.poll(connectedManifest.id, "flow-1");
      await Promise.resolve();
      expect(pollCalls).toBe(0);
      reservation!.release();
      await polling;
      expect(pollCalls).toBe(1);
      await registry.close();
    } finally {
      releaseInvocationCleanup?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("propagates caller cancellation before a provider lifecycle commit is admitted", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-lifecycle-caller-cancel-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    let markConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    let releaseCancelledConnect!: () => void;
    const cancelledConnectGate = new Promise<void>((resolve) => {
      releaseCancelledConnect = resolve;
    });
    let connectCalls = 0;
    let toolCalls = 0;
    const baseProvider = provider("test-connected-provider", state);
    const cancellableProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (_capabilities, context) => {
        connectCalls += 1;
        if (connectCalls > 1) return baseProvider.connect!([]);
        if (!context) throw new Error("Lifecycle context is required.");
        providerSignal = context.signal;
        markConnectStarted();
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        await cancelledConnectGate;
        throw new Error("Cancelled provider work settled.");
      },
      invoke: async (...args) => {
        toolCalls += 1;
        return baseProvider.invoke(...args);
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, cancellableProvider)],
        undefined,
        undefined,
        { providerStatusTimeoutMs: 20, providerOperationTimeoutMs: 20 },
      );
      await registry.install(connectedManifest.id);
      await registry.list();
      expect(registry.isToolAvailableSync("test.records.list")).toBe(true);
      const controller = new AbortController();
      const connecting = registry.connect(connectedManifest.id, undefined, {
        signal: controller.signal,
      });
      await connectStarted;
      controller.abort(new Error("RPC caller cancelled."));

      await expect(connecting).rejects.toMatchObject({ code: "operation_failed" });
      expect(providerSignal?.aborted).toBe(true);
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      expect(registry.isSkillAvailableSync("test-records")).toBe(false);
      expect(registry.reserveSkillsSync(["test-records"])).toBeNull();
      await expect(registry.invokeTool("test.records.list", {})).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect(toolCalls).toBe(0);
      expect((await registry.list()).integrations[0]?.tools[0]?.available).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      const queuedConnect = registry.connect(connectedManifest.id);
      await expect(queuedConnect).rejects.toMatchObject({ code: "operation_failed" });
      expect(connectCalls).toBe(1);
      await expect(
        NodeFSP.access(NodePath.join(root, "commit-journal", `${connectedManifest.id}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      releaseCancelledConnect();
      await registry.close();
    } finally {
      releaseCancelledConnect?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("does not publish a stale deferred cancellation refresh after disconnect", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-cancel-refresh-serialization-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    let markConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    let delayStatus = false;
    let markStatusStarted!: () => void;
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    let markStatusReturned!: () => void;
    const statusReturned = new Promise<void>((resolve) => {
      markStatusReturned = resolve;
    });
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    let disconnectCalls = 0;
    const skillSyncs: Array<ReadonlyArray<string>> = [];
    const materializer: IntegrationSkillMaterializer = {
      reconcileCatalog: async () => undefined,
      sync: async ({ activeSkills }) => {
        skillSyncs.push([...activeSkills]);
      },
    };
    const baseProvider = provider("test-connected-provider", state);
    const delayedProvider: IntegrationProvider = {
      ...baseProvider,
      status: async () => {
        const captured = state.status;
        if (delayStatus) {
          delayStatus = false;
          markStatusStarted();
          await statusGate;
          markStatusReturned();
        }
        return captured;
      },
      connect: async (_capabilities, context) => {
        if (!context) throw new Error("Lifecycle context is required.");
        markConnectStarted();
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        await connectGate;
        throw new Error("Cancelled connection settled.");
      },
      disconnect: async (...args) => {
        disconnectCalls += 1;
        return baseProvider.disconnect!(...args);
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, delayedProvider)],
        materializer,
        undefined,
        { providerOperationTimeoutMs: 200 },
      );
      await registry.install(connectedManifest.id);
      const controller = new AbortController();
      const connecting = registry.connect(connectedManifest.id, undefined, {
        signal: controller.signal,
      });
      await connectStarted;
      controller.abort();
      await expect(connecting).rejects.toMatchObject({ code: "operation_failed" });

      skillSyncs.length = 0;
      delayStatus = true;
      releaseConnect();
      await statusStarted;
      const disconnecting = registry.disconnect(connectedManifest.id);
      await disconnecting;
      expect(disconnectCalls).toBe(1);
      expect(skillSyncs.length).toBeGreaterThan(0);
      expect(skillSyncs.every((activeSkills) => activeSkills.length === 0)).toBe(true);
      expect((await registry.snapshot()).integrations[0]).toMatchObject({
        connectionState: "not_connected",
      });
      releaseStatus();
      await statusReturned;
      // statusStarted proves the deferred refresh is already inside #summarize, so close drains
      // that exact refresh instead of allowing the closing guard to skip it.
      await registry.close();
      expect(skillSyncs.every((activeSkills) => activeSkills.length === 0)).toBe(true);
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
    } finally {
      releaseConnect?.();
      releaseStatus?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("serializes stale skill materialization behind a newer disconnect", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-cancel-skill-sync-serialization-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    let markConnectStarted!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
      markConnectStarted = resolve;
    });
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    let delayNextActiveSync = false;
    let markStaleSyncStarted!: () => void;
    const staleSyncStarted = new Promise<void>((resolve) => {
      markStaleSyncStarted = resolve;
    });
    let releaseStaleSync!: () => void;
    const staleSyncGate = new Promise<void>((resolve) => {
      releaseStaleSync = resolve;
    });
    let watchingInactiveSync = false;
    let inactiveSyncStarted = false;
    let skillActive = false;
    const materializer: IntegrationSkillMaterializer = {
      reconcileCatalog: async () => undefined,
      sync: async ({ activeSkills }) => {
        if (delayNextActiveSync && activeSkills.length > 0) {
          delayNextActiveSync = false;
          markStaleSyncStarted();
          await staleSyncGate;
        }
        if (watchingInactiveSync && activeSkills.length === 0) inactiveSyncStarted = true;
        skillActive = activeSkills.length > 0;
      },
    };
    const baseProvider = provider("test-connected-provider", state);
    const cancellableProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (_capabilities, context) => {
        if (!context) throw new Error("Lifecycle context is required.");
        markConnectStarted();
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        await connectGate;
        throw new Error("Cancelled connection settled.");
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, cancellableProvider)],
        materializer,
        undefined,
        { providerOperationTimeoutMs: 200 },
      );
      await registry.install(connectedManifest.id);
      expect(skillActive).toBe(true);

      const controller = new AbortController();
      const connecting = registry.connect(connectedManifest.id, undefined, {
        signal: controller.signal,
      });
      await connectStarted;
      controller.abort();
      await expect(connecting).rejects.toMatchObject({ code: "operation_failed" });

      delayNextActiveSync = true;
      releaseConnect();
      await staleSyncStarted;
      watchingInactiveSync = true;
      const disconnecting = registry.disconnect(connectedManifest.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inactiveSyncStarted).toBe(false);

      releaseStaleSync();
      await disconnecting;
      await registry.close();
      expect(inactiveSyncStarted).toBe(true);
      expect(skillActive).toBe(false);
    } finally {
      releaseConnect?.();
      releaseStaleSync?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("does not let stale skill-sync cleanup erase a newer successful sync", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-stale-skill-cleanup-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    let markFirstConnectStarted!: () => void;
    const firstConnectStarted = new Promise<void>((resolve) => {
      markFirstConnectStarted = resolve;
    });
    let releaseFirstConnect!: () => void;
    const firstConnectGate = new Promise<void>((resolve) => {
      releaseFirstConnect = resolve;
    });
    let markSecondConnectReturned!: () => void;
    const secondConnectReturned = new Promise<void>((resolve) => {
      markSecondConnectReturned = resolve;
    });
    let failNextActiveSync = false;
    let markStaleSyncStarted!: () => void;
    const staleSyncStarted = new Promise<void>((resolve) => {
      markStaleSyncStarted = resolve;
    });
    let releaseStaleSync!: () => void;
    const staleSyncGate = new Promise<void>((resolve) => {
      releaseStaleSync = resolve;
    });
    let watchingInactiveSync = false;
    let inactiveSyncs = 0;
    let skillActive = false;
    const materializer: IntegrationSkillMaterializer = {
      reconcileCatalog: async () => undefined,
      sync: async ({ activeSkills }) => {
        if (failNextActiveSync && activeSkills.length > 0) {
          failNextActiveSync = false;
          markStaleSyncStarted();
          await staleSyncGate;
          throw new Error("Stale materialization failed.");
        }
        if (watchingInactiveSync && activeSkills.length === 0) inactiveSyncs += 1;
        skillActive = activeSkills.length > 0;
      },
    };
    const baseProvider = provider("test-connected-provider", state);
    let connectCalls = 0;
    const reconnectableProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (_capabilities, context) => {
        connectCalls += 1;
        if (connectCalls === 1) {
          if (!context) throw new Error("Lifecycle context is required.");
          markFirstConnectStarted();
          if (!context.signal.aborted) {
            await new Promise<void>((resolve) =>
              context.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          }
          await firstConnectGate;
          throw new Error("Cancelled connection settled.");
        }
        markSecondConnectReturned();
        return {
          kind: "device_code",
          flowId: "flow-2",
          verificationUri: "https://fixture.invalid/device",
          verificationUriComplete: null,
          userCode: "IJKL-MNOP",
          message: "Sign in.",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          intervalSeconds: 1,
        };
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, reconnectableProvider)],
        materializer,
        undefined,
        { providerOperationTimeoutMs: 200 },
      );
      await registry.install(connectedManifest.id);
      expect(skillActive).toBe(true);

      const controller = new AbortController();
      const connecting = registry.connect(connectedManifest.id, undefined, {
        signal: controller.signal,
      });
      await firstConnectStarted;
      controller.abort();
      await expect(connecting).rejects.toMatchObject({ code: "operation_failed" });

      failNextActiveSync = true;
      releaseFirstConnect();
      await staleSyncStarted;
      watchingInactiveSync = true;
      const reconnecting = registry.connect(connectedManifest.id);
      await secondConnectReturned;
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseStaleSync();

      await reconnecting;
      await registry.close();
      expect(connectCalls).toBe(2);
      expect(inactiveSyncs).toBe(0);
      expect(skillActive).toBe(true);
    } finally {
      releaseFirstConnect?.();
      releaseStaleSync?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("does not reset a faulted provider while timed-out lifecycle work is still settling", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-lifecycle-reset-race-"),
    );
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
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    let markConnectSettled!: () => void;
    const connectSettled = new Promise<void>((resolve) => {
      markConnectSettled = resolve;
    });
    let disconnectCalls = 0;
    const baseProvider = provider("test-connected-provider", state);
    const slowProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async () => {
        await connectGate;
        state.credential = "present";
        markConnectSettled();
        throw new Error("Timed-out provider work settled late.");
      },
      disconnect: async (context) => {
        disconnectCalls += 1;
        return baseProvider.disconnect!(context);
      },
      close: async () => releaseConnect(),
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, slowProvider)],
        undefined,
        undefined,
        { providerStatusTimeoutMs: 20, providerOperationTimeoutMs: 20 },
      );
      await registry.install(connectedManifest.id);
      await expect(registry.connect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });

      await expect(registry.disconnect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect(disconnectCalls).toBe(0);

      releaseConnect();
      await connectSettled;
      await Promise.resolve();
      expect(state.credential).toBe("present");
      await registry.disconnect(connectedManifest.id);
      expect(disconnectCalls).toBe(1);
      expect(state.credential).toBeNull();
      await registry.close();
    } finally {
      releaseConnect?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("makes close wait for an admitted bounded external commit without overlapping provider close", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-commit-handshake-"),
    );
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
    let markCommitStarted!: () => void;
    let releaseCommit!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let closeCalls = 0;
    let closeOverlappedCommit = false;
    let commitActive = false;
    const baseProvider = provider("test-connected-provider", state);
    const committingProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (_capabilities, context) => {
        if (!context) throw new Error("Lifecycle context is required.");
        await context.beginCommit();
        commitActive = true;
        markCommitStarted();
        await commitGate;
        expect(context.signal.aborted).toBe(false);
        commitActive = false;
        return baseProvider.connect!(["records.read"], context);
      },
      close: async () => {
        closeCalls += 1;
        closeOverlappedCommit = commitActive;
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, committingProvider)],
        undefined,
        undefined,
        { providerStatusTimeoutMs: 20, providerOperationTimeoutMs: 200 },
      );
      await registry.install(connectedManifest.id);
      const connecting = registry.connect(connectedManifest.id);
      await commitStarted;
      const closing = registry.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(closeCalls).toBe(0);
      expect(commitActive).toBe(true);
      releaseCommit();
      await expect(connecting).resolves.toMatchObject({ kind: "device_code" });
      await closing;
      expect(closeCalls).toBe(1);
      expect(closeOverlappedCommit).toBe(false);
    } finally {
      releaseCommit?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("drains aborted tool work before admitting a commit and closes after it settles", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-commit-and-invoke-close-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    let markInvocationStarted!: () => void;
    const invocationStarted = new Promise<void>((resolve) => {
      markInvocationStarted = resolve;
    });
    let markCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let commitActive = false;
    let closeCalls = 0;
    let closeOverlappedCommit = false;
    const baseProvider = provider("test-connected-provider", state);
    const mixedWorkProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (_capabilities, context) => {
        if (!context) throw new Error("Lifecycle context is required.");
        await context.beginCommit();
        commitActive = true;
        markCommitStarted();
        await commitGate;
        commitActive = false;
        return baseProvider.connect!(["records.read"], context);
      },
      invoke: async (_name, _input, context) => {
        if (!context) throw new Error("Invocation context is required.");
        markInvocationStarted();
        if (!context.signal.aborted) {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return { records: [] };
      },
      close: async () => {
        closeCalls += 1;
        closeOverlappedCommit ||= commitActive;
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, mixedWorkProvider)],
        undefined,
        undefined,
        { providerStatusTimeoutMs: 100, providerOperationTimeoutMs: 100 },
      );
      await registry.install(connectedManifest.id);
      const invocationResult = registry.invokeTool("test.records.list", {}).then(
        () => ({ resolved: true as const }),
        (error: unknown) => ({ resolved: false as const, error }),
      );
      await invocationStarted;
      const connecting = registry.connect(connectedManifest.id);
      await commitStarted;

      const startedAt = Date.now();
      const closing = registry.close();
      expect(closeCalls).toBe(0);
      releaseCommit();

      await expect(connecting).resolves.toMatchObject({ kind: "device_code" });
      await closing;
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(closeCalls).toBe(1);
      expect(closeOverlappedCommit).toBe(false);
      const invocation = await invocationResult;
      expect(invocation.resolved).toBe(false);
      if (!invocation.resolved) expect(invocation.error).toMatchObject({ code: "disabled" });
    } finally {
      releaseCommit?.();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("journals and faults a commit tail that misses its bounded deadline", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-commit-journal-"));
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
    let markCommitStarted!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    let closeCalls = 0;
    let commitSignalAborted = false;
    const baseProvider = provider("test-connected-provider", state);
    const hangingProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (_capabilities, context) => {
        if (!context) throw new Error("Lifecycle context is required.");
        const commitSignal = await context.beginCommit();
        commitSignal.addEventListener(
          "abort",
          () => {
            commitSignalAborted = true;
          },
          { once: true },
        );
        markCommitStarted();
        return new Promise<never>(() => undefined);
      },
      close: async () => {
        closeCalls += 1;
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, hangingProvider)],
        undefined,
        undefined,
        { providerStatusTimeoutMs: 50, providerOperationTimeoutMs: 500 },
      );
      await registry.install(connectedManifest.id);
      const connecting = registry.connect(connectedManifest.id).then(
        (value) => ({ resolved: true as const, value }),
        (error: unknown) => ({ resolved: false as const, error }),
      );
      const commitAdmitted = await Promise.race([
        commitStarted.then(() => true),
        connecting.then(() => false),
      ]);
      expect(commitAdmitted).toBe(true);
      const connection = await connecting;
      expect(connection.resolved).toBe(false);
      if (!connection.resolved)
        expect(connection.error).toMatchObject({ code: "operation_failed" });
      expect(commitSignalAborted).toBe(true);
      await expect(registry.disconnect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });

      const closeStartedAt = Date.now();
      await expect(registry.close()).rejects.toThrow(/drain/u);
      expect(Date.now() - closeStartedAt).toBeLessThan(2_000);
      expect(closeCalls).toBe(0);

      const recoveryState: ProviderState = {
        status: {
          state: "connected",
          accountLabel: "Indeterminate account",
          grantedCapabilities: ["records.read"],
          message: null,
        },
        credential: "present",
        disconnectFails: false,
      };
      const restarted = new RegistryRuntime(root, [
        packaged(connectedManifest, provider("test-connected-provider", recoveryState)),
      ]);
      expect((await restarted.list()).integrations[0]).toMatchObject({
        connectionState: "error",
      });
      expect(restarted.isToolAvailableSync("test.records.list")).toBe(false);

      await restarted.disconnect(connectedManifest.id);
      expect(recoveryState.credential).toBeNull();
      expect((await restarted.list()).integrations[0]).toMatchObject({
        connectionState: "not_connected",
      });
      await expect(
        NodeFSP.access(NodePath.join(root, "commit-journal", `${connectedManifest.id}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await restarted.close();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a recovery journal when reset is cancelled before commit admission", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-preserved-recovery-journal-"),
    );
    const state: ProviderState = {
      status: {
        state: "connected",
        accountLabel: "Fixture",
        grantedCapabilities: ["records.read"],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    const journalPath = NodePath.join(root, "commit-journal", `${connectedManifest.id}.json`);
    const controller = new AbortController();
    const baseProvider = provider("test-connected-provider", state);
    const cancelledResetProvider: IntegrationProvider = {
      ...baseProvider,
      disconnect: async (context) => {
        if (!context) throw new Error("Lifecycle context is required.");
        const admission = context.beginCommit();
        controller.abort();
        await admission;
      },
    };
    try {
      const initial = new RegistryRuntime(root, [packaged(connectedManifest, baseProvider)]);
      await initial.install(connectedManifest.id);
      await initial.close();
      await NodeFSP.mkdir(NodePath.dirname(journalPath), { recursive: true });
      await NodeFSP.writeFile(
        journalPath,
        JSON.stringify({
          version: 1,
          integrationId: connectedManifest.id,
          providerId: baseProvider.id,
        }),
      );

      const registry = new RegistryRuntime(root, [
        packaged(connectedManifest, cancelledResetProvider),
      ]);
      expect((await registry.list()).integrations[0]?.connectionState).toBe("error");
      await expect(
        registry.disconnect(connectedManifest.id, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "operation_failed" });
      await expect(NodeFSP.access(journalPath)).resolves.toBeUndefined();
      await registry.close();

      const restarted = new RegistryRuntime(root, [packaged(connectedManifest, baseProvider)]);
      expect((await restarted.list()).integrations[0]?.connectionState).toBe("error");
      await restarted.close();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("retains the commit journal when an admitted provider rejects promptly", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-rejected-commit-journal-"),
    );
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
    const baseProvider = provider("test-connected-provider", state);
    const rejectingProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (_capabilities, context) => {
        if (!context) throw new Error("Lifecycle context is required.");
        await context.beginCommit();
        state.credential = "present";
        throw new Error("Credential commit result was ambiguous.");
      },
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, rejectingProvider)]);
      await registry.install(connectedManifest.id);
      await expect(registry.connect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect((await registry.snapshot()).integrations[0]).toMatchObject({
        connectionState: "error",
      });
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      await expect(
        NodeFSP.access(NodePath.join(root, "commit-journal", `${connectedManifest.id}.json`)),
      ).resolves.toBeUndefined();
      await registry.close();

      const recoveryState: ProviderState = {
        status: {
          state: "connected",
          accountLabel: "Indeterminate account",
          grantedCapabilities: ["records.read"],
          message: null,
        },
        credential: "present",
        disconnectFails: false,
      };
      const restarted = new RegistryRuntime(root, [
        packaged(connectedManifest, provider("test-connected-provider", recoveryState)),
      ]);
      expect((await restarted.list()).integrations[0]).toMatchObject({
        connectionState: "error",
      });
      await restarted.disconnect(connectedManifest.id);
      expect(recoveryState.credential).toBeNull();
      await expect(
        NodeFSP.access(NodePath.join(root, "commit-journal", `${connectedManifest.id}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await restarted.close();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("retains the commit journal when an admitted provider returns an invalid poll result", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-invalid-poll-commit-journal-"),
    );
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
    const baseProvider = provider("test-connected-provider", state);
    const malformedProvider: IntegrationProvider = {
      ...baseProvider,
      poll: async (_flowId, context) => {
        if (!context) throw new Error("Lifecycle context is required.");
        await context.beginCommit();
        state.credential = "present";
        return {
          state: "connected",
          retryAfterSeconds: 0,
          message: null,
        } as never;
      },
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, malformedProvider)]);
      await registry.install(connectedManifest.id);
      const flow = await registry.connect(connectedManifest.id);

      await expect(registry.poll(connectedManifest.id, flow.flowId)).rejects.toMatchObject({
        code: "operation_failed",
      });
      expect((await registry.snapshot()).integrations[0]).toMatchObject({
        connectionState: "error",
      });
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      await expect(
        NodeFSP.access(NodePath.join(root, "commit-journal", `${connectedManifest.id}.json`)),
      ).resolves.toBeUndefined();

      await registry.disconnect(connectedManifest.id);
      expect(state.credential).toBeNull();
      await expect(
        NodeFSP.access(NodePath.join(root, "commit-journal", `${connectedManifest.id}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await registry.close();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed connection results at the provider boundary", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-invalid-connect-"));
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
    const baseProvider = provider("test-connected-provider", state);
    const malformedProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async () => ({
        kind: "device_code",
        flowId: "flow-1",
        verificationUri: "https://fixture.invalid/device",
        verificationUriComplete: null,
        userCode: "ABCD-EFGH",
        message: "Sign in.",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        intervalSeconds: 0,
      }),
    } as IntegrationProvider;
    try {
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, malformedProvider)]);
      await registry.install(connectedManifest.id);
      await expect(registry.connect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      await expect(
        NodeFSP.access(NodePath.join(root, "commit-journal", `${connectedManifest.id}.json`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await registry.close();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a commit point after the lifecycle deadline has already won", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-late-commit-"));
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
    let markCommitRefused!: () => void;
    const commitRefused = new Promise<void>((resolve) => {
      markCommitRefused = resolve;
    });
    const baseProvider = provider("test-connected-provider", state);
    const lateProvider: IntegrationProvider = {
      ...baseProvider,
      connect: async (_capabilities, context) => {
        if (!context) throw new Error("Lifecycle context is required.");
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await expect(context.beginCommit()).rejects.toThrow(/cancelled/u);
        markCommitRefused();
        throw new Error("Late commit was refused.");
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(connectedManifest, lateProvider)],
        undefined,
        undefined,
        { providerOperationTimeoutMs: 20 },
      );
      await registry.install(connectedManifest.id);
      await expect(registry.connect(connectedManifest.id)).rejects.toMatchObject({
        code: "operation_failed",
      });
      await commitRefused;
      expect(registry.isToolAvailableSync("test.records.list")).toBe(false);
      await registry.close();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("aborts and drains an in-flight tool before close completes", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-invoke-close-"));
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
    let invocationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      invocationStarted = resolve;
    });
    let releaseInvocation!: () => void;
    const invocationGate = new Promise<void>((resolve) => {
      releaseInvocation = resolve;
    });
    let closeCalls = 0;
    const delayedProvider: IntegrationProvider = {
      ...provider("test-fixture-provider", state),
      invoke: async () => {
        invocationStarted();
        await invocationGate;
        return { records: [] };
      },
      close: async () => {
        closeCalls += 1;
        releaseInvocation();
      },
    };
    try {
      const registry = new RegistryRuntime(
        root,
        [packaged(fixtureManifest, delayedProvider)],
        undefined,
        undefined,
        { providerStatusTimeoutMs: 20 },
      );
      await registry.install(fixtureManifest.id);
      const invocation = registry.invokeTool("test.fixture.read", {});
      const invocationResult = invocation.then(
        () => ({ resolved: true as const }),
        (error: unknown) => ({ resolved: false as const, error }),
      );
      await started;
      const startedAt = Date.now();
      await registry.close();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      const result = await invocationResult;
      expect(result.resolved).toBe(false);
      if (!result.resolved) expect(result.error).toMatchObject({ code: "disabled" });
      expect(closeCalls).toBe(1);
    } finally {
      releaseInvocation();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("closes each provider once without disconnecting its credentials", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-provider-close-"));
    const state: ProviderState = {
      status: {
        state: "not_connected",
        accountLabel: null,
        grantedCapabilities: [],
        message: null,
      },
      credential: "present",
      disconnectFails: false,
    };
    let closeCalls = 0;
    const closableProvider: IntegrationProvider = {
      ...provider("test-fixture-provider", state),
      close: async () => {
        closeCalls += 1;
      },
    };
    try {
      const registry = new RegistryRuntime(root, [packaged(fixtureManifest, closableProvider)]);
      await registry.list();
      await Promise.all([registry.close(), registry.close()]);
      expect(closeCalls).toBe(1);
      expect(state.credential).toBe("present");
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
          state.credential = "present";
          return baseProvider.connect!(["records.read"]);
        },
      };
      const registry = new RegistryRuntime(root, [packaged(connectedManifest, delayedProvider)]);
      await registry.install(connectedManifest.id);
      const connecting = registry.connect(connectedManifest.id);
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
