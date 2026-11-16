import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports other missing capabilities with the neutral error", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "provider-session-1",
    thread: {
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("pull-requests").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({
      capability: "pull-requests",
      threadId: invocation.thread?.threadId,
    });

    const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    expect(scope).toBe(invocation);
  });
});

it.effect("refuses thread-owned capabilities to a caller signed in from outside a thread", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "client:session-1",
    thread: undefined,
    client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
    capabilities: new Set(["preview", "orchestration"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({ capability: "preview", environmentId: "environment-1" });
    expect(error.threadId).toBeUndefined();
  });
});

it("acts at an administrator's ceiling for a client approved above it", () => {
  const scope = (
    access: McpInvocationContext.McpClientCaller["access"],
    narrowedTo?: McpInvocationContext.ClientModes,
  ): McpInvocationContext.McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "client:session-1",
    thread: undefined,
    client: { sessionId: "session-1", label: "Claude Code", access, narrowedTo },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });
  const modes = (invocation: McpInvocationContext.McpInvocationScope, ceiling?: "auto") =>
    McpInvocationContext.clientModeCeiling(
      McpInvocationContext.withRuntimeModeCeiling(invocation, ceiling).client,
    );

  expect(modes(scope("full-access"), "auto")).toEqual({
    runtimeMode: "auto",
    interactionMode: "default",
  });
  // A narrower request and the approved mode still win below the ceiling.
  expect(
    modes(
      scope("full-access", { runtimeMode: "approval-required", interactionMode: "plan" }),
      "auto",
    ),
  ).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
  expect(modes(scope("auto-accept-edits"), "auto").runtimeMode).toBe("auto-accept-edits");
  expect(modes(scope("full-access")).runtimeMode).toBe("full-access");
});

it.effect("keeps external MCP thread links on the paired origin unless hosting is configured", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    for (const { origin, hosted, peer, expected } of [
      {
        origin: "http://127.0.0.1:3773",
        hosted: undefined,
        peer: false,
        expected: "http://127.0.0.1:3773/environment-1/thread-1",
      },
      {
        origin: "https://harness.example.ts.net",
        hosted: undefined,
        peer: false,
        expected: "https://harness.example.ts.net/environment-1/thread-1",
      },
      {
        origin: "https://harness.example.ts.net",
        hosted: "invalid",
        peer: false,
        expected: "https://harness.example.ts.net/environment-1/thread-1",
      },
      {
        origin: "http://127.0.0.1:3773",
        hosted: "https://workspace.example.test",
        peer: false,
        expected: "https://workspace.example.test/threads/environment-1/thread-1",
      },
      {
        origin: "http://127.0.0.1:3773",
        hosted: undefined,
        peer: true,
        expected: "<t3-thread://v2/environment-1/thread-1>",
      },
    ]) {
      const scope = yield* Effect.gen(function* () {
        const authenticator = yield* McpHttpServer.McpClientAuthenticator;
        return yield* authenticator.authenticate(
          HttpServerRequest.fromWeb(
            new Request(`${origin}/mcp`, {
              headers: {
                host: new URL(origin).host,
                "x-forwarded-proto": new URL(origin).protocol.slice(0, -1),
              },
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          McpOAuth.layerMcpClientAuthenticator.pipe(
            Layer.provide(
              Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
                authenticateMcpClient: () =>
                  Effect.succeed({
                    sessionId: "mcp-test",
                    label: "External client",
                    access: "auto",
                    peerLink: peer,
                  }),
              } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
            ),
            Layer.provide(
              Layer.succeed(ServerEnvironment.ServerEnvironment, {
                getEnvironmentId: Effect.succeed(environmentId),
              } as ServerEnvironment.ServerEnvironment["Service"]),
            ),
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: hosted === undefined ? {} : { T3CODE_HOSTED_APP_URL: hosted },
                }),
              ),
            ),
          ),
        ),
      );
      expect(scope).toBeDefined();
      expect(McpInvocationContext.threadLinkFor(scope!, threadId)).toBe(expected);
    }
  }),
);
