import * as Result from "effect/Result";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import {
  type AssetCreateUrlResult,
  EnvironmentId,
  ThreadId,
  EnvironmentAuthorizationError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceAssetNotFoundError,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";

import { createAssetEnvironmentAtoms, createProjectFaviconUrlAtomFamily } from "./assets.ts";

describe("createAssetEnvironmentAtoms", () => {
  it.effect.each([
    { name: "missing video", path: "/tmp/clip.mp4", fallback: true },
    { name: "literal filename characters", path: "/tmp/frame#one?two.png", fallback: true },
    { name: "windows path", path: "C:\\Users\\demo\\clip.mp4", fallback: true },
    { name: "inspection failure", path: "/tmp/clip.mp4", error: "inspection", fallback: true },
    { name: "foreign thread", path: "/tmp/clip.mp4", error: "context", fallback: true },
    { name: "missing on both hosts", path: "/tmp/clip.mp4", localFails: true },
    {
      name: "a defect in the local retry",
      path: "/tmp/clip.mp4",
      localFails: true,
      localDefect: true,
    },
    { name: "remote success", path: "/tmp/clip.mp4", success: true },
    { name: "relative path", path: "clip.mp4" },
    { name: "no primary", path: "/tmp/clip.mp4", primary: "none" },
    { name: "primary reconnect", path: "/tmp/frame.png", primary: "reconnecting" },
    { name: "same environment", path: "/tmp/clip.mp4", primary: "same" },
    { name: "non-media", path: "/tmp/report.html" },
    { name: "explicit download", path: "/tmp/frame.png", download: true },
    { name: "authorization failure", path: "/tmp/clip.mp4", error: "auth" },
  ])("uses the correct environment for $name", (scenario) =>
    Effect.gen(function* () {
      const remoteId = EnvironmentId.make("remote");
      const localId = EnvironmentId.make("local");
      const resource = {
        _tag: "media-file" as const,
        threadId: ThreadId.make("foreign-thread"),
        path: scenario.path,
        ...(scenario.download ? { disposition: "attachment" as const } : {}),
      };
      const error =
        scenario.error === "auth"
          ? new EnvironmentAuthorizationError({
              message: "denied",
              requiredScope: "orchestration:read",
            })
          : scenario.error === "inspection"
            ? new AssetWorkspaceAssetInspectionError({ resource, cause: new Error("unreadable") })
            : scenario.error === "context"
              ? new AssetWorkspaceContextNotFoundError({ resource })
              : new AssetWorkspaceAssetNotFoundError({ resource, checkedPath: "/tmp/clip.mp4" });
      const calls: EnvironmentId[] = [];
      const supervisors = new Map<
        EnvironmentId,
        EnvironmentSupervisor.EnvironmentSupervisor["Service"]
      >();
      for (const environmentId of [remoteId, localId]) {
        const client = {
          [WS_METHODS.assetsCreateUrl]: () => {
            calls.push(environmentId);
            if (environmentId === localId && scenario.localFails) {
              const localError = Effect.fail(
                new AssetWorkspaceAssetNotFoundError({ resource, checkedPath: "/local/clip.mp4" }),
              );
              return scenario.localDefect
                ? localError.pipe(Effect.ensuring(Effect.die("cleanup failed")))
                : localError;
            }
            return environmentId === remoteId && !scenario.success
              ? Effect.fail(error)
              : Effect.succeed({
                  relativeUrl: `/api/assets/${environmentId}/media`,
                  expiresAt: 999999,
                });
          },
        } as unknown as WsRpcProtocolClient;
        const session = { client } as RpcSession;
        supervisors.set(
          environmentId,
          EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: environmentId,
              httpBaseUrl: `https://${environmentId}.test`,
              wsBaseUrl: `wss://${environmentId}.test`,
            }),
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected" as const,
            }),
            session: yield* SubscriptionRef.make(Option.some(session)),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          }),
        );
      }
      const environments = EnvironmentRegistry.EnvironmentRegistry.of({
        run: (id, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisors.get(id)!,
          ),
        followStream: (id, stream) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisors.get(id)!,
          ),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const localTarget = {
        environmentId: scenario.primary === "same" ? remoteId : localId,
        httpBaseUrl: "https://local.test",
      };
      const localEnvironment = Atom.make<typeof localTarget | null>(
        scenario.primary === "none" || scenario.primary === "reconnecting" ? null : localTarget,
      );
      const assets = createAssetEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
        localEnvironment,
      );
      const query = assets.createUrl({ environmentId: remoteId, input: { resource } });
      const result = AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
      if (scenario.fallback || scenario.success) {
        expect((yield* result).relativeUrl).toBe(
          scenario.fallback
            ? "https://local.test/api/assets/local/media"
            : "/api/assets/remote/media",
        );
      } else if (scenario.localDefect) {
        const cause = yield* Effect.sandbox(result).pipe(Effect.flip);
        expect(Cause.findErrorOption(cause)).toEqual(Option.some(error));
        expect(Cause.findDefect(cause)).toEqual(Result.succeed("cleanup failed"));
      } else {
        expect(yield* Effect.flip(result)).toEqual(error);
      }
      expect(calls).toEqual(
        scenario.fallback || scenario.localFails ? [remoteId, localId] : [remoteId],
      );
      if (scenario.primary === "reconnecting") {
        registry.set(localEnvironment, localTarget);
        expect((yield* result).relativeUrl).toBe("https://local.test/api/assets/local/media");
        expect(calls).toEqual([remoteId, remoteId, localId]);
      }
    }).pipe(Effect.scoped),
  );

  it("keys collections while preserving independent resource queries", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry.EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const resources = [
      { _tag: "attachment" as const, threadId, attachmentId: "attachment-1" },
      { _tag: "attachment" as const, threadId, attachmentId: "attachment-2" },
    ];

    expect(assets.createUrls({ environmentId, resources })).toBe(
      assets.createUrls({
        environmentId,
        resources: resources.map((resource) => ({ ...resource })),
      }),
    );
    expect(
      assets.createUrls({
        environmentId,
        resources: [...resources].toReversed(),
      }),
    ).not.toBe(assets.createUrls({ environmentId, resources }));
  });
});

describe("project favicon URL cache", () => {
  it("does not reuse another environment, workspace, or selected icon's cached URL", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: "/api/assets/token/icon.svg",
      }),
    );
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => Atom.make(Option.some({ httpBaseUrl: "https://remote.test" })),
    });
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const unmount = registry.mount(favicon(target));
    try {
      expect(registry.get(favicon(target))).toBe("https://remote.test/api/assets/token/icon.svg");
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(
        registry.get(favicon({ ...target, environmentId: EnvironmentId.make("other") })),
      ).toBeNull();
      expect(registry.get(favicon({ ...target, cwd: "/other" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: "brand.svg" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: null }))).toBe(
        "https://remote.test/api/assets/token/icon.svg",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
