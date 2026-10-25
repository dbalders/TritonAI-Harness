// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Synthetic clock and real journal I/O exercise authority changes during admission.
import { expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createRegistryRuntime, type IntegrationProvider } from "./IntegrationRegistry.ts";
import type { IntegrationManifest } from "./manifest.ts";
import {
  installIntegrationWriteGate,
  invalidateIntegrationCredentials,
  type IntegrationWriteReview,
} from "./IntegrationWriteApproval.ts";
import { integrationWriteTestOwner as owner } from "./IntegrationWriteApproval.testkit.ts";

const journalGate = vi.hoisted(() => ({
  path: "",
  entered: () => {},
  wait: Promise.resolve(),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args);
      if (String(args[1]) === journalGate.path) {
        journalGate.entered();
        await journalGate.wait;
      }
    },
  };
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "harness-write-binding-"));
  const manifest: IntegrationManifest = {
    apiVersion: "tritonai.harness/v2",
    kind: "IntegrationPlugin",
    manifestVersion: 2,
    id: "approval-binding-fixture",
    name: "Approval fixture",
    description: "Synthetic write target.",
    version: "1.0.0",
    provider: "approval-fixture-provider",
    capabilities: [
      {
        id: "fixture.write",
        displayName: "Write",
        description: "Synthetic write.",
        access: "default",
      },
    ],
    tools: [
      {
        name: "approval.fixture.write",
        displayName: "Write",
        description: "Synthetic write.",
        capabilities: ["fixture.write"],
        effect: "write",
      },
    ],
    skills: [],
  };
  const writes: unknown[] = [];
  const provider: IntegrationProvider = {
    id: manifest.provider!,
    tools: [
      {
        name: "approval.fixture.write",
        description: "Synthetic write.",
        input: Schema.Struct({ destination: Schema.String, body: Schema.String }),
        readOnly: false,
        openWorld: false,
      },
    ],
    status: async () => ({
      state: "connected",
      accountLabel: "Synthetic owner",
      grantedCapabilities: ["fixture.write"],
      message: null,
    }),
    connect: async () => ({ kind: "connected", flowId: "synthetic", message: "Connected" }),
    disconnect: async () => {},
    invoke: async (_name, input, context) => {
      await context!.beginCommit!();
      writes.push(input);
      return { ok: true };
    },
  };
  const registry = await createRegistryRuntime(root, [{ manifest, provider }]);
  await registry.install(manifest.id);
  return {
    registry,
    writes,
    manifest,
    journal: NodePath.join(root, "commit-journal", `${manifest.id}.json`),
    context: { signal: new AbortController().signal, approvalOwner: owner },
    async [Symbol.asyncDispose]() {
      journalGate.path = "";
      await registry.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it("cannot use a caller boolean or a missing presenter as write authority", async () => {
  await using state = await fixture();
  const payload = { destination: "synthetic-one", body: "unchanged" };
  await expect(
    state.registry.invokeTool("approval.fixture.write", payload, {
      signal: state.context.signal,
      writeApproved: true,
    }),
  ).rejects.toMatchObject({ code: "operation_failed" });
  await expect(
    state.registry.invokeTool("approval.fixture.write", payload, state.context),
  ).rejects.toMatchObject({ code: "operation_failed" });
  expect(state.writes).toEqual([]);
});

it("executes only the detached reviewed arguments and asks again for the same tool", async () => {
  await using state = await fixture();
  const pending = Promise.withResolvers<IntegrationWriteReview>();
  const decision = Promise.withResolvers<void>();
  const reviews: IntegrationWriteReview[] = [];
  using _presenter = installIntegrationWriteGate(owner.providerInstanceId, (review) => {
    reviews.push(review);
    if (reviews.length > 1) return Effect.succeed({ approved: false } as const);
    pending.resolve(review);
    return Effect.promise(() => decision.promise).pipe(
      Effect.as({ approved: true as const, isCurrent: () => true }),
    );
  });
  const payload = { destination: "synthetic-one", body: `${"line\n".repeat(300)}reviewed tail` };
  const call = state.registry.invokeTool("approval.fixture.write", payload, state.context);
  const review = await pending.promise;
  expect(JSON.parse(review.payload)).toEqual(payload);
  expect(review.owner).toEqual(owner);
  const expected = { ...payload };
  payload.destination = "substituted-target";
  payload.body = "substituted code";
  decision.resolve();
  await expect(call).resolves.toEqual({ ok: true });
  expect(state.writes).toEqual([expected]);
  await expect(
    state.registry.invokeTool("approval.fixture.write", payload, state.context),
  ).rejects.toMatchObject({ code: "operation_failed" });
  expect(reviews).toHaveLength(2);
  expect(reviews[1]!.requestId).not.toBe(review.requestId);
  expect(reviews[1]!.submittedDigest).not.toBe(review.submittedDigest);
  expect(state.writes).toHaveLength(1);
});

it.each(["credential", "expiry", "presenter", "owner", "connection"] as const)(
  "refuses stale authority after journal I/O: %s",
  async (change) => {
    let now = 1_800_000_000_000;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    await using state = await fixture();
    let active = true;
    using presenter = installIntegrationWriteGate(owner.providerInstanceId, () =>
      Effect.succeed({ approved: true as const, isCurrent: () => active }),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    journalGate.path = state.journal;
    journalGate.entered = entered.resolve;
    journalGate.wait = release.promise;
    const result = state.registry
      .invokeTool(
        "approval.fixture.write",
        {
          destination: "synthetic-one",
          body: "no write may commit",
        },
        state.context,
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await entered.promise;
    let disabled: Promise<unknown> | undefined;
    if (change === "credential") invalidateIntegrationCredentials(state.manifest.id);
    else if (change === "expiry") now += 5 * 60_000 + 1;
    else if (change === "presenter") presenter[Symbol.dispose]();
    else if (change === "owner") active = false;
    else disabled = state.registry.setEnabled(state.manifest.id, false);
    release.resolve();
    const settled = await result;
    expect(settled.ok).toBe(false);
    expect(state.writes).toEqual([]);
    await disabled;
    await expect(NodeFSP.access(state.journal)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
