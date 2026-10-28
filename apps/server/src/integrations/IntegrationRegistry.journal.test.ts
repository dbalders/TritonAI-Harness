// @effect-diagnostics nodeBuiltinImport:off - Exercises the real journal filesystem boundary.
import { beforeEach, onTestFinished } from "vite-plus/test";
import {
  installApprovedIntegrationWriteFixture,
  integrationWriteTestOwner,
} from "./IntegrationWriteApproval.testkit.ts";

beforeEach(() => {
  const presenter = installApprovedIntegrationWriteFixture();
  onTestFinished(() => presenter[Symbol.dispose]());
});

import { expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createRegistryRuntime, type IntegrationProvider } from "./IntegrationRegistry.ts";
import { EmptyIntegrationToolInput } from "./IntegrationTool.ts";
import type { IntegrationManifest } from "./manifest.ts";

const gate = vi.hoisted(() => ({
  paths: [] as string[],
  blocked: false,
  started: () => {},
  wait: Promise.resolve(),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (!gate.blocked && gate.paths.includes(String(args[0]))) {
        gate.blocked = true;
        gate.started();
        await gate.wait;
      }
      return fs.rm(...args);
    },
  };
});

it("holds write admission until the previous journal cleanup finishes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "tritonai-journal-lock-"));
  const manifest: IntegrationManifest = {
    apiVersion: "tritonai.harness/v2",
    kind: "IntegrationPlugin",
    manifestVersion: 2,
    id: "journal-lock-fixture",
    name: "Journal lock fixture",
    description: "Tests journal finalization.",
    version: "1.0.0",
    provider: "journal-lock-provider",
    capabilities: [
      {
        id: "fixture.write",
        displayName: "Write",
        description: "Write fixture.",
        access: "default",
      },
    ],
    tools: [
      {
        name: "journal.fixture.write",
        displayName: "Write",
        description: "Write fixture.",
        capabilities: ["fixture.write"],
        effect: "write",
      },
    ],
    skills: [],
  };
  let calls = 0;
  const provider: IntegrationProvider = {
    id: manifest.provider!,
    tools: [
      {
        name: "journal.fixture.write",
        description: "Write fixture.",
        input: EmptyIntegrationToolInput,
        readOnly: false,
        openWorld: false,
      },
    ],
    status: async () => ({
      state: "connected",
      accountLabel: null,
      grantedCapabilities: ["fixture.write"],
      message: null,
    }),
    connect: async () => ({ kind: "connected", flowId: "fixture", message: "Connected." }),
    disconnect: async () => {},
    invoke: async (_name, _input, context) => {
      await context!.beginCommit!();
      calls++;
      return { ok: true };
    },
  };
  const registry = await createRegistryRuntime(root, [{ manifest, provider }]);
  let release!: () => void;
  let first: Promise<unknown> | undefined;
  try {
    await registry.install(manifest.id);
    const journal = NodePath.join(root, "commit-journal", `${manifest.id}.json`);
    gate.paths = [
      journal,
      NodePath.join(await NodeFSP.realpath(root), "commit-journal", `${manifest.id}.json`),
    ];
    const started = new Promise<void>((resolve) => {
      gate.started = resolve;
    });
    gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const context = {
      signal: new AbortController().signal,
      writeApproved: true,
      approvalOwner: integrationWriteTestOwner,
    };
    first = registry.invokeTool("journal.fixture.write", {}, context);
    await started;
    await expect(registry.invokeTool("journal.fixture.write", {}, context)).rejects.toMatchObject({
      code: "operation_failed",
    });
    expect(calls).toBe(1);
    await expect(NodeFSP.access(journal)).resolves.toBeUndefined();
    release();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(NodeFSP.access(journal)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release?.();
    gate.paths = [];
    await first?.catch(() => undefined);
    await registry.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
