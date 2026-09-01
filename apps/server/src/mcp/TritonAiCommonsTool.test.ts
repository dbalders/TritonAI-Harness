import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { vi } from "vite-plus/test";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  invokeTritonAiCommonsTool,
  registrationLayer,
  TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
} from "./TritonAiCommonsTool.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const signal = new AbortController().signal;

it("requires runtime write approval before resolving or submitting a skill", async () => {
  const submit = vi.fn();
  const result = await invokeTritonAiCommonsTool({
    arguments: { skillName: "accessibility-review", confirmedPublicShare: true },
    providerInstanceId,
    signal,
    writeApproved: false,
    runtime: { submit },
  });

  expect(result).toEqual({
    status: "approval_required",
    message: "Public sharing was not approved. No GitHub write was attempted.",
  });
  expect(submit).not.toHaveBeenCalled();
});

it("binds the exact selector to the current provider and returns bounded review metadata", async () => {
  const submit = vi.fn(async () => ({
    reviewUrl: "https://github.com/dbalders/UCSD-Skills-Library/pull/42",
    branch: "internal-branch-is-not-model-visible",
    path: "community/accessibility-review/SKILL.md",
    skillName: "accessibility-review",
  }));
  const result = await invokeTritonAiCommonsTool({
    arguments: { skillName: "accessibility-review", confirmedPublicShare: true },
    providerInstanceId,
    signal,
    writeApproved: true,
    runtime: { submit },
  });

  expect(submit).toHaveBeenCalledWith(
    {
      instanceId: providerInstanceId,
      skillName: "accessibility-review",
      confirmedPublicShare: true,
    },
    signal,
  );
  expect(result).toMatchObject({
    status: "review_opened",
    reviewUrl: "https://github.com/dbalders/UCSD-Skills-Library/pull/42",
  });
  expect(result).not.toHaveProperty("branch");
});

it("rejects ambiguous or unconfirmed arguments before the domain service", async () => {
  const submit = vi.fn();
  for (const argumentsValue of [
    { skillName: "one", skillPath: "/two/SKILL.md", confirmedPublicShare: true },
    { skillName: "one", confirmedPublicShare: false },
    { skillName: "one", confirmedPublicShare: true, unexpected: true },
  ]) {
    const result = await invokeTritonAiCommonsTool({
      arguments: argumentsValue,
      providerInstanceId,
      signal,
      writeApproved: true,
      runtime: { submit },
    });
    expect(result.status).toBe("invalid_skill");
  }
  expect(submit).not.toHaveBeenCalled();
});

it.effect(
  "registers a destructive, idempotent tool only for Commons-scoped provider sessions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const registration = server.tools.find(
          ({ tool }) => tool.name === TRITONAI_COMMONS_SUBMIT_TOOL_NAME,
        );
        expect(registration?.tool.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        });
        const enabledWhen = Context.getUnsafe(registration!.annotations, McpSchema.EnabledWhen);
        const allowed = yield* Effect.sync(() => enabledWhen({} as never)).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment-1"),
            threadId: ThreadId.make("thread-1"),
            providerSessionId: "provider-session-1",
            providerInstanceId,
            capabilities: new Set<McpInvocationContext.McpCapability>(["commons.submit"]),
            issuedAt: 1,
          }),
        );
        expect(allowed).toBe(true);
      }).pipe(
        Effect.provide(registrationLayer.pipe(Layer.provideMerge(McpServer.McpServer.layer))),
      ),
    ),
);
