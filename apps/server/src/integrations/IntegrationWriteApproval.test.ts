// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Synthetic clock and real journal I/O exercise authority changes during admission.
import { expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createRegistryRuntime, type IntegrationProvider } from "./IntegrationRegistry.ts";
import type { IntegrationManifest } from "./manifest.ts";
import type { IntegrationProviderTool } from "./IntegrationTool.ts";
import {
  installIntegrationWriteGate,
  invalidateIntegrationCredentials,
  type IntegrationWriteReview,
  integrationCredentialGeneration,
  integrationCredentialMutationPending,
  beginIntegrationCredentialMutation,
} from "./IntegrationWriteApproval.ts";
import { scopeIntegrationSecretStore } from "./IntegrationSecretStore.ts";
import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { integrationWriteTestOwner as owner } from "./IntegrationWriteApproval.testkit.ts";

const journalGate = vi.hoisted(() => ({
  path: "",
  entered: () => {},
  wait: Promise.resolve(),
  phase: "rename" as "rename" | "lstat",
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args);
      if (journalGate.phase === "rename" && String(args[1]) === journalGate.path) {
        journalGate.entered();
        await journalGate.wait;
      }
    },
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      try {
        return await fs.lstat(...args);
      } finally {
        if (journalGate.phase === "lstat" && String(args[0]) === journalGate.path) {
          journalGate.entered();
          await journalGate.wait;
        }
      }
    },
  };
});

async function fixture(
  options: {
    readonly account?: () => Promise<string>;
    readonly beforeCommit?: () => Promise<void>;
    readonly afterCommit?: () => Promise<void>;
    readonly input?: IntegrationProviderTool["input"];
  } = {},
) {
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
        input: options.input ?? Schema.Struct({ destination: Schema.String, body: Schema.String }),
        readOnly: false,
        openWorld: false,
      },
    ],
    status: async () => ({
      state: "connected",
      accountLabel: options.account ? await options.account() : "Synthetic owner",
      grantedCapabilities: ["fixture.write"],
      message: null,
    }),
    connect: async () => ({ kind: "connected", flowId: "synthetic", message: "Connected" }),
    disconnect: async () => {},
    invoke: async (_name, input, context) => {
      await options.beforeCommit?.();
      await context!.beginCommit!();
      await options.afterCommit?.();
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
      journalGate.phase = "rename";
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

it("reviews and executes decoded defaults and transforms with distinct input digests", async () => {
  await using state = await fixture({
    input: Schema.Struct({
      destination: Schema.String.pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("synthetic-default")),
      ),
      count: Schema.NumberFromString,
    }),
  });
  const reviews: IntegrationWriteReview[] = [];
  using _presenter = installIntegrationWriteGate(owner.providerInstanceId, (review) => {
    reviews.push(review);
    return Effect.succeed({ approved: true as const, isCurrent: () => true });
  });
  await state.registry.invokeTool("approval.fixture.write", { count: "5" }, state.context);
  expect(JSON.parse(reviews[0]!.payload)).toEqual({ destination: "synthetic-default", count: 5 });
  expect(reviews[0]!.submittedDigest).not.toBe(reviews[0]!.effectiveDigest);
  expect(state.writes).toEqual([{ destination: "synthetic-default", count: 5 }]);
});

it("detaches nested payloads while the exact write waits for review", async () => {
  await using state = await fixture({
    input: Schema.Struct({
      destination: Schema.String,
      document: Schema.Struct({ lines: Schema.Array(Schema.String) }),
    }),
  });
  const shown = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<void>();
  using _presenter = installIntegrationWriteGate(owner.providerInstanceId, (review) => {
    expect(review.payload).toContain("original final line");
    shown.resolve();
    return Effect.promise(() => answer.promise).pipe(
      Effect.as({ approved: true as const, isCurrent: () => true }),
    );
  });
  const input = { destination: "synthetic-target", document: { lines: ["original final line"] } };
  const running = state.registry.invokeTool("approval.fixture.write", input, state.context);
  await shown.promise;
  input.document.lines[0] = "substituted hidden tail";
  input.document.lines.push("another change");
  answer.resolve();
  await running;
  expect(state.writes).toEqual([
    { destination: "synthetic-target", document: { lines: ["original final line"] } },
  ]);
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

it.each(["precommit", "lstat"] as const)(
  "keeps the connection usable after an early authority refusal: %s",
  async (phase) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await using state = await fixture({
      beforeCommit: async () => {
        if (phase === "precommit") {
          entered.resolve();
          await release.promise;
        }
      },
    });
    using _presenter = installIntegrationWriteGate(owner.providerInstanceId, () =>
      Effect.succeed({ approved: true as const, isCurrent: () => true }),
    );
    if (phase === "lstat") {
      journalGate.path = state.journal;
      journalGate.phase = "lstat";
      journalGate.entered = entered.resolve;
      journalGate.wait = release.promise;
    }
    const result = state.registry
      .invokeTool(
        "approval.fixture.write",
        { destination: "synthetic", body: "original" },
        state.context,
      )
      .then(
        () => false,
        () => true,
      );
    await entered.promise;
    invalidateIntegrationCredentials(state.manifest.id);
    release.resolve();
    expect(await result).toBe(true);
    expect(state.writes).toEqual([]);
    await expect(NodeFSP.access(state.journal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      state.registry.invokeTool(
        "approval.fixture.write",
        { destination: "synthetic", body: "fresh" },
        state.context,
      ),
    ).resolves.toEqual({ ok: true });
    expect(state.writes).toHaveLength(1);
  },
);

effectIt.effect("refuses a review born during a credential mutation, including cancellation", () =>
  Effect.gen(function* () {
    let principal = "synthetic-account-A";
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const state = yield* Effect.acquireRelease(
      Effect.promise(() => fixture({ account: async () => principal })),
      (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
    );
    const store: ServerSecretStore.ServerSecretStore["Service"] = {
      get: () => Effect.succeed(Option.none()),
      set: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          principal = "synthetic-account-B";
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
    };
    const scoped = scopeIntegrationSecretStore(store, state.manifest.id);
    const reviews: IntegrationWriteReview[] = [];
    using _presenter = installIntegrationWriteGate(owner.providerInstanceId, (review) => {
      reviews.push(review);
      return Effect.succeed({ approved: true as const, isCurrent: () => true });
    });
    const generation = integrationCredentialGeneration(state.manifest.id);
    const mutation = yield* scoped.set("identity", new Uint8Array()).pipe(Effect.forkScoped);
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid));
    yield* Deferred.await(started);
    yield* Effect.promise(() =>
      expect(
        state.registry.invokeTool(
          "approval.fixture.write",
          {
            destination: "synthetic",
            body: "must not approve account A",
          },
          state.context,
        ),
      ).rejects.toMatchObject({ code: "operation_failed" }),
    );
    expect(reviews).toEqual([]);
    expect(state.writes).toEqual([]);
    // Request interruption without waiting for the protected credential write to settle.
    yield* Effect.sync(() => mutation.interruptUnsafe());
    expect(integrationCredentialMutationPending(state.manifest.id)).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.await(mutation);
    expect(integrationCredentialMutationPending(state.manifest.id)).toBe(false);
    expect(integrationCredentialGeneration(state.manifest.id)).toBeGreaterThan(generation + 1);
    yield* Effect.promise(() =>
      state.registry.invokeTool(
        "approval.fixture.write",
        {
          destination: "synthetic",
          body: "fresh account B review",
        },
        state.context,
      ),
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.accountLabel).toBe("synthetic-account-B");
    expect(state.writes).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it("does not combine an old account status with a newer credential revision", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  let principal = "synthetic-account-A";
  await using state = await fixture({
    account: async () => {
      const account = principal;
      if (hold) {
        started.resolve();
        await release.promise;
      }
      return account;
    },
  });
  const reviews: IntegrationWriteReview[] = [];
  using _presenter = installIntegrationWriteGate(owner.providerInstanceId, (review) => {
    reviews.push(review);
    return Effect.succeed({ approved: true as const, isCurrent: () => true });
  });
  hold = true;
  const result = state.registry
    .invokeTool(
      "approval.fixture.write",
      { destination: "synthetic", body: "old review" },
      state.context,
    )
    .then(
      () => false,
      () => true,
    );
  await started.promise;
  const settle = beginIntegrationCredentialMutation(state.manifest.id);
  principal = "synthetic-account-B";
  settle();
  hold = false;
  release.resolve();
  expect(await result).toBe(true);
  expect(reviews).toEqual([]);
  expect(state.writes).toEqual([]);
  await state.registry.invokeTool(
    "approval.fixture.write",
    { destination: "synthetic", body: "fresh" },
    state.context,
  );
  expect(reviews[0]!.accountLabel).toBe("synthetic-account-B");
  expect(state.writes).toHaveLength(1);
});

effectIt.effect("keeps an admitted write on its reviewed account until provider work settles", () =>
  Effect.gen(function* () {
    let principal = "synthetic-account-A";
    let executedAs: string | undefined;
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const state = yield* Effect.acquireRelease(
      Effect.promise(() =>
        fixture({
          account: async () => principal,
          afterCommit: async () => {
            admitted.resolve();
            await release.promise;
            executedAs = principal;
          },
        }),
      ),
      (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
    );
    const store: ServerSecretStore.ServerSecretStore["Service"] = {
      get: () => Effect.succeed(Option.none()),
      set: () =>
        Effect.sync(() => {
          principal = "synthetic-account-B";
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
    };
    const scoped = scopeIntegrationSecretStore(store, state.manifest.id);
    using _presenter = installIntegrationWriteGate(owner.providerInstanceId, (review) => {
      expect(review.accountLabel).toBe("synthetic-account-A");
      return Effect.succeed({ approved: true as const, isCurrent: () => true });
    });
    const running = yield* Effect.promise(() =>
      state.registry.invokeTool(
        "approval.fixture.write",
        { destination: "synthetic", body: "reviewed" },
        state.context,
      ),
    ).pipe(Effect.forkScoped);
    yield* Effect.addFinalizer(() => Effect.sync(release.resolve));
    yield* Effect.promise(() => admitted.promise);
    const mutation = yield* scoped.set("identity", new Uint8Array()).pipe(Effect.exit);
    expect(mutation._tag).toBe("Failure");
    expect(principal).toBe("synthetic-account-A");
    release.resolve();
    yield* Fiber.join(running);
    expect(executedAs).toBe("synthetic-account-A");
    yield* scoped.set("identity", new Uint8Array());
    expect(principal).toBe("synthetic-account-B");
  }).pipe(Effect.scoped),
);

it.each(["payload", "metadata"] as const)(
  "refuses oversized %s before publishing an approval or invoking the provider",
  async (scope) => {
    await using state = await fixture(
      scope === "metadata" ? { account: async () => "a".repeat(1024 * 1024 + 1) } : {},
    );
    const reviews: IntegrationWriteReview[] = [];
    using _presenter = installIntegrationWriteGate(owner.providerInstanceId, (review) => {
      reviews.push(review);
      return Effect.succeed({ approved: true as const, isCurrent: () => true });
    });
    await expect(
      state.registry.invokeTool(
        "approval.fixture.write",
        {
          destination: "synthetic-one",
          body: scope === "payload" ? "x".repeat(700 * 1024) : "Small change",
        },
        state.context,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(reviews).toEqual([]);
    expect(state.writes).toEqual([]);
  },
);
