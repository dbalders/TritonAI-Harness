import { type AuthEnvironmentScope } from "@t3tools/contracts";
import type * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { ProjectId } from "@t3tools/contracts";

import { AuthSessionId } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";

import { type HelpContext } from "@t3tools/contracts";

import {
  AuthEnvironmentMaintainScope,
  ORCHESTRATION_V2_WS_METHODS,
  AuthStandardClientScopes,
  CommandId,
  MessageId,
  RuntimeRequestId,
  type OrchestrationV2Command,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  DeviceHostId,
  type DeviceListInput,
  type DeviceServiceState,
  type ScheduledTask,
  ScheduledTaskId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";

import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as Stream from "effect/Stream";

import * as RpcTest from "effect/rpc/RpcTest";

import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [
      WS_METHODS.terminalObserve,
      WS_METHODS.subscribeTerminalEvents,
      WS_METHODS.subscribeTerminalMetadata,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalRestart,
      WS_METHODS.terminalClose,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

describe("device tooling authority", () => {
  const method = WS_METHODS.deviceList;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
    ),
  );
  const state: DeviceServiceState = {
    hosts: [],
    hostStatus: "ready",
    hostStatuses: {},
    devices: [],
    sessions: [],
    onboardingCompleted: true,
    agentAccessEnabled: true,
    hubBasePath: "/api/device-hub",
    revision: 1,
  };
  // Each of these installs, updates, or restarts host tooling.
  const controlInputs: ReadonlyArray<DeviceListInput> = [
    { updateTool: "hub" },
    { updateTool: "agent", inspectOnly: true },
    { retryHostId: DeviceHostId.make("remote-host") },
  ];
  const deviceClient = (scopes: ReadonlyArray<AuthEnvironmentScope>, handled: unknown[]) =>
    RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(method, (input) =>
            Effect.sync(() => {
              handled.push(input);
              return state;
            }),
          ),
          RpcAuthorization.layer(scopes),
        ),
      ),
    );

  it.effect.each(AuthStandardClientScopes)(
    "refuses tool installs and host restarts when %s is missing",
    (missing) =>
      Effect.gen(function* () {
        const handled: unknown[] = [];
        const client = yield* deviceClient(
          AuthStandardClientScopes.filter((scope) => scope !== missing),
          handled,
        );
        for (const input of controlInputs) {
          expect(yield* client[method](input).pipe(Effect.flip)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: missing,
          });
        }
        expect(handled).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("lets full device authority manage tooling and read-only sessions list devices", () =>
    Effect.gen(function* () {
      const handled: unknown[] = [];
      const full = yield* deviceClient(AuthStandardClientScopes, handled);
      for (const input of controlInputs) expect(yield* full[method](input)).toEqual(state);
      expect(handled).toEqual(controlInputs);

      const readHandled: unknown[] = [];
      const reader = yield* deviceClient([AuthOrchestrationReadScope], readHandled);
      expect(yield* reader[method]({})).toEqual(state);
      expect(yield* reader[method]({ inspectOnly: true })).toEqual(state);
      expect(readHandled).toEqual([{}, { inspectOnly: true }]);
    }).pipe(Effect.scoped),
  );
});

describe("scheduled task webhook disclosure", () => {
  const webhookTask = (url: string | null): ScheduledTask => ({
    id: ScheduledTaskId.make(`scheduled-task:${url === null ? "local" : "relay"}`),
    title: "On push",
    prompt: "Summarize {{body.ref}}",
    enabled: true,
    schedule: { type: "webhook", signature: null },
    projectId: ProjectId.make("project:webhook"),
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
    // The path alone carries the bearer token, even with no public URL.
    webhook: {
      path: "/api/hooks/scheduled-task/synthetic-bearer-token",
      url,
      hasSecret: false,
    },
  });
  const listed = { tasks: [webhookTask(null), webhookTask("https://relay.test/h/synthetic")] };

  it.each(AuthStandardClientScopes)("withholds webhook paths and URLs when %s is missing", (m) => {
    const visible = RpcAuthorization.withVisibleWebhooks(
      AuthStandardClientScopes.filter((scope) => scope !== m),
      listed,
    );
    expect(visible.tasks.map((task) => task.id)).toEqual(listed.tasks.map((task) => task.id));
    expect(JSON.stringify(visible)).not.toContain("synthetic-bearer-token");
    expect(JSON.stringify(visible)).not.toContain("relay.test");
  });

  it("shows webhooks only to full device authority and tasks to read-only sessions", () => {
    expect(RpcAuthorization.withVisibleWebhooks(AuthStandardClientScopes, listed)).toEqual(listed);
    const readOnly = RpcAuthorization.withVisibleWebhooks([AuthOrchestrationReadScope], listed);
    expect(readOnly.tasks.map((task) => [task.title, task.webhook])).toEqual([
      ["On push", undefined],
      ["On push", undefined],
    ]);
  });
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("Help RPC authorization", () => {
  const tested = [WS_METHODS.helpGetContext, WS_METHODS.helpAsk] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const context = {
    capturedAt: "2026-10-22T12:00:00.000Z",
    environmentId: EnvironmentId.make("help-environment"),
    environmentName: "Help test environment",
    version: "test",
    platform: "darwin",
    mode: "desktop",
    paths: [],
    providers: [],
    modelLabel: "Test model",
    diagnostics: {
      recordCount: 1,
      failureCount: 0,
      slowSpanCount: 0,
      partial: false,
      recentFailures: [],
    },
  } satisfies HelpContext;
  const question = {
    messages: [{ role: "user" as const, content: "Where can I find provider settings?" }],
  };
  const authenticatedSession = (
    scopes: ReadonlyArray<AuthEnvironmentScope>,
  ): EnvironmentAuth.AuthenticatedSession => ({
    sessionId: AuthSessionId.make("help-session"),
    subject: "help-test-user",
    method: "bearer-access-token",
    scopes,
  });
  const makeClient = (session: EnvironmentAuth.AuthenticatedSession, handled: Array<string>) =>
    RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.helpGetContext, () =>
            Effect.sync(() => {
              handled.push("context");
              return context;
            }),
          ),
          group.toLayerHandler(WS_METHODS.helpAsk, () =>
            Effect.sync(() => {
              handled.push("ask");
              return { answer: "Open Settings > Providers.", context };
            }),
          ),
          // Match /ws: grants come from the authenticated connection, not its request payload.
          RpcAuthorization.layer(session.scopes),
        ),
      ),
    );

  it.effect.each([
    { scopes: [], missing: AuthOrchestrationOperateScope },
    {
      scopes: [AuthOrchestrationOperateScope, AuthDiagnosticsReadScope],
      missing: AuthOrchestrationReadScope,
    },
    {
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("denies Help invocation without $missing before the handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const session = authenticatedSession(scopes);
      const client = yield* makeClient(session, handled);
      const forgedGrants = {
        ...question,
        scopes: [AuthOrchestrationOperateScope, AuthDiagnosticsReadScope],
        permissions: [AuthOrchestrationOperateScope, AuthDiagnosticsReadScope],
        requiredScopes: [],
        session: {
          ...session,
          scopes: [AuthOrchestrationOperateScope, AuthDiagnosticsReadScope],
        },
      };

      for (const input of [question, forgedGrants]) {
        expect(yield* client[WS_METHODS.helpAsk](input).pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: missing,
        });
      }
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects forged snapshot grants when the session lacks diagnostics access", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const session = authenticatedSession([AuthOrchestrationOperateScope]);
      const client = yield* makeClient(session, handled);
      const forgedGrants = {
        scopes: [AuthDiagnosticsReadScope],
        permissions: [AuthDiagnosticsReadScope],
        session: { ...session, scopes: [AuthDiagnosticsReadScope] },
      };

      expect(
        yield* client[WS_METHODS.helpGetContext](forgedGrants).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthDiagnosticsReadScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not expose host settings or plugin inventory to diagnostics-only sessions", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* makeClient(authenticatedSession([AuthDiagnosticsReadScope]), handled);
      expect(yield* client[WS_METHODS.helpGetContext]({}).pipe(Effect.flip)).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationReadScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("does not expose captured project files with only orchestration read access", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.projectBriefGet> =>
          tag !== WS_METHODS.projectBriefGet,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.projectBriefGet, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    const result = yield* client[WS_METHODS.projectBriefGet]({
      projectId: ProjectId.make("project"),
    }).pipe(Effect.flip);
    expect(result).toMatchObject({ requiredPermission: AuthFilesystemReadScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("does not expose project memory with only orchestration read access", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverGetProjectMemory
        > => tag !== WS_METHODS.serverGetProjectMemory,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverGetProjectMemory, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    const result = yield* client[WS_METHODS.serverGetProjectMemory]({
      projectId: ProjectId.make("project"),
    }).pipe(Effect.flip);
    expect(result).toMatchObject({ requiredPermission: AuthFilesystemReadScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("does not expose archived source snapshots without filesystem permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.projectBriefArchiveGet
        > => tag !== WS_METHODS.projectBriefArchiveGet,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.projectBriefArchiveGet, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    const result = yield* client[WS_METHODS.projectBriefArchiveGet]({
      projectId: ProjectId.make("project"),
      archiveId: "archive-1",
    }).pipe(Effect.flip);
    expect(result).toMatchObject({ requiredPermission: AuthFilesystemReadScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("requires filesystem permission before project-brief capture or dispatch", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.projectBriefExecute
        > => tag !== WS_METHODS.projectBriefExecute,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.projectBriefExecute, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer(
            AuthStandardClientScopes.filter((scope) => scope !== AuthFilesystemReadScope),
          ),
        ),
      ),
    );
    const result = yield* client[WS_METHODS.projectBriefExecute]({
      projectId: ProjectId.make("project"),
      requestId: "capture-1",
      expectedRevision: 0,
      action: "addSource",
      source: { kind: "file", relativePath: "plan.md" },
    }).pipe(Effect.flip);
    expect(result).toMatchObject({ requiredPermission: AuthFilesystemReadScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("protects cached project overviews with filesystem permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          | typeof WS_METHODS.projectOverviewGet
          | typeof WS_METHODS.projectOverviewSubscribe
          | typeof WS_METHODS.projectOverviewEnsure
          | typeof WS_METHODS.projectOverviewDismiss
          | typeof WS_METHODS.projectOverviewRestore
        > =>
          tag !== WS_METHODS.projectOverviewGet &&
          tag !== WS_METHODS.projectOverviewSubscribe &&
          tag !== WS_METHODS.projectOverviewEnsure &&
          tag !== WS_METHODS.projectOverviewDismiss &&
          tag !== WS_METHODS.projectOverviewRestore,
      ),
    );
    let handled = false;
    const denyHandler = () =>
      Effect.sync(() => {
        handled = true;
      }).pipe(Effect.andThen(Effect.never));
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.projectOverviewGet, denyHandler),
          group.toLayerHandler(WS_METHODS.projectOverviewSubscribe, () =>
            Stream.fromEffect(denyHandler()),
          ),
          group.toLayerHandler(WS_METHODS.projectOverviewEnsure, denyHandler),
          group.toLayerHandler(WS_METHODS.projectOverviewDismiss, denyHandler),
          group.toLayerHandler(WS_METHODS.projectOverviewRestore, denyHandler),
          RpcAuthorization.layer(
            AuthStandardClientScopes.filter((scope) => scope !== AuthFilesystemReadScope),
          ),
        ),
      ),
    );
    const input = { projectId: ProjectId.make("project") };
    expect(yield* client[WS_METHODS.projectOverviewGet](input).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthFilesystemReadScope,
    });
    expect(
      yield* client[WS_METHODS.projectOverviewSubscribe](input).pipe(Stream.runDrain, Effect.flip),
    ).toMatchObject({ requiredPermission: AuthFilesystemReadScope });
    expect(yield* client[WS_METHODS.projectOverviewEnsure](input).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthFilesystemReadScope,
    });
    expect(
      yield* client[WS_METHODS.projectOverviewDismiss]({
        ...input,
        stepId: "step",
        kind: "done",
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthFilesystemReadScope });
    expect(yield* client[WS_METHODS.projectOverviewRestore](input).pipe(Effect.flip)).toMatchObject(
      {
        requiredPermission: AuthFilesystemReadScope,
      },
    );
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("agent control authority", () => {
  const method = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
    ),
  );
  const commandId = CommandId.make("authority-command");
  const threadId = ThreadId.make("existing-full-access-thread");
  const commands: ReadonlyArray<OrchestrationV2Command> = [
    ...["approval-required", "auto-accept-edits", "auto", "full-access"].map((runtimeMode) => ({
      type: "thread.runtime-mode.set" as const,
      commandId,
      threadId,
      runtimeMode: runtimeMode as
        | "approval-required"
        | "auto-accept-edits"
        | "auto"
        | "full-access",
    })),
    {
      type: "runtime-request.respond" as const,
      commandId,
      threadId,
      requestId: RuntimeRequestId.make("pending-approval"),
      decision: "accept" as const,
    },
    {
      type: "message.dispatch" as const,
      createdBy: "user",
      creationSource: "web",
      commandId,
      threadId,
      messageId: MessageId.make("follow-up"),
      text: "synthetic continuation",
      attachments: [],
      dispatchMode: { type: "start_immediately" as const },
    },
  ];

  it.effect.each(AuthStandardClientScopes)(
    "denies existing-thread commands when %s is missing",
    (missing) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(method, (command) =>
                Effect.sync(() => {
                  handled.push(command.type);
                  return { sequence: 1 };
                }),
              ),
              RpcAuthorization.layer(AuthStandardClientScopes.filter((scope) => scope !== missing)),
            ),
          ),
        );
        for (const command of commands) {
          expect(yield* client[method](command).pipe(Effect.flip)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: missing,
          });
        }
        expect(handled).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("preserves explicitly authorized full-control commands", () =>
    Effect.gen(function* () {
      const handled: string[] = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, (command) =>
              Effect.sync(() => {
                handled.push(command.type);
                return { sequence: 1 };
              }),
            ),
            RpcAuthorization.layer(AuthStandardClientScopes),
          ),
        ),
      );
      for (const command of commands)
        expect(yield* client[method](command)).toEqual({ sequence: 1 });
      expect(handled).toHaveLength(commands.length);
    }).pipe(Effect.scoped),
  );
});

it.effect(
  "denies narrow-token launches in all runtime modes before provider/session creation",
  () =>
    Effect.gen(function* () {
      const method = ORCHESTRATION_V2_WS_METHODS.launchThread;
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
        ),
      );
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, () =>
              Effect.sync(() => {
                handled = true;
              }).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
          ),
        ),
      );
      for (const runtimeMode of [
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ] as const) {
        expect(
          yield* client[method]({
            commandId: CommandId.make("launch"),
            projectId: ProjectId.make("project"),
            title: "Synthetic launch",
            runtimeMode,
            interactionMode: "default",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "synthetic" },
            workspaceStrategy: { type: "root" },
          }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthSettingsWriteScope,
        });
      }
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
);
