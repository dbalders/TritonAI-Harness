import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  HelpError,
  HelpContext,
  type HelpClientContext,
  type IntegrationsListResult,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerTraceDiagnosticsResult,
  TextGenerationError,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type {
  HelpGenerationInput,
  HelpGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";
import { createModelSelection } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Help from "./Help.ts";
import * as HelpDocumentation from "./HelpDocumentation.ts";
import * as HelpIntegrations from "./HelpIntegrations.ts";

const at = DateTime.makeUnsafe("2026-10-22T12:00:00.000Z");
const instanceId = ProviderInstanceId.make("configured-help");
const selection = createModelSelection(instanceId, "selected-support-model", [
  { id: "reasoningEffort", value: "ultra" },
  { id: "serviceTier", value: "priority" },
]);
const secret = "sk-proj-abcdef0123456789";
const isHelpContext = Schema.is(HelpContext);
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Configured runtime",
  enabled: true,
  installed: true,
  version: "0.156.1",
  status: "ready",
  auth: { status: "unknown", email: "private@example.test", label: secret },
  checkedAt: "2026-10-21T01:00:00.000Z",
  message: `provider payload ${secret}`,
  runtimePaths: { homePath: "/private/provider-home", shadowHomePath: null },
  models: [],
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;
const descriptor = {
  environmentId: EnvironmentId.make("remote-server"),
  label: "Configured host",
  platform: { os: "linux", arch: "arm64" },
  serverVersion: "1.2.3-test",
} as ExecutionEnvironmentDescriptor;

function trace(
  overrides: Partial<ServerTraceDiagnosticsResult> = {},
): ServerTraceDiagnosticsResult {
  return {
    traceFilePath: "/private/raw.trace",
    scannedFilePaths: ["/private/raw.trace"],
    readAt: at,
    recordCount: 15,
    parseErrorCount: 0,
    firstSpanAt: Option.some(at),
    lastSpanAt: Option.some(at),
    failureCount: 7,
    interruptionCount: 0,
    slowSpanThresholdMs: 1_000,
    slowSpanCount: 3,
    logLevelCounts: {},
    topSpansByCount: [],
    slowestSpans: [],
    commonFailures: [],
    latestFailures: Array.from({ length: 7 }, (_, index) => ({
      name: index === 0 ? "ws.rpc.server.getSettings" : `prompt.${secret}`,
      cause: `Authentication failed: ${secret} raw user prompt`,
      durationMs: 50,
      endedAt: at,
      traceId: "private-trace-id",
      spanId: "private-span-id",
    })),
    latestWarningAndErrorLogs: [
      {
        spanName: "private log operation",
        level: "ERROR",
        message: `raw log ${secret}`,
        seenAt: at,
        traceId: "private-trace-id",
        spanId: "private-span-id",
      },
    ],
    partialFailure: Option.none(),
    error: Option.none(),
    ...overrides,
  };
}

const harness = Effect.fn(function* (
  options: {
    readonly generate?: (
      input: HelpGenerationInput,
    ) => Effect.Effect<HelpGenerationResult, TextGenerationError>;
    readonly unsupported?: boolean;
    readonly missing?: boolean;
    readonly disabled?: boolean;
    readonly trace?: ServerTraceDiagnosticsResult;
    readonly inventory?: () => IntegrationsListResult | undefined;
    readonly documentationUnavailable?: boolean;
    readonly realDocumentation?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "help-test-" });
  const calls: HelpGenerationInput[] = [];
  let refreshes = 0;
  let pluginReads = 0;
  const documentationQuestions: string[] = [];
  const documentationContexts: (string | undefined)[] = [];
  const generation = TextGeneration.TextGeneration.of({
    generateCommitMessage: () => Effect.die("Unexpected commit generation"),
    generatePrContent: () => Effect.die("Unexpected PR generation"),
    generateBranchName: () => Effect.die("Unexpected branch generation"),
    generateThreadTitle: () => Effect.die("Unexpected title generation"),
    generateReviewGuide: () => Effect.die("Unexpected review generation"),
    ...(options.unsupported
      ? {}
      : {
          generateHelp: (input: HelpGenerationInput) =>
            Effect.sync(() => calls.push(input)).pipe(
              Effect.andThen(
                options.generate?.(input) ??
                  Effect.succeed({ answer: "Check the connected environment." }),
              ),
            ),
        }),
  });
  // Unused instance members are deliberately absent: Help must never reach the adapter,
  // authentication controller, workspace discovery or provider filesystem through them.
  const instance = {
    instanceId,
    enabled: !options.disabled,
    textGeneration: generation,
  } as ProviderInstance;
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest("/host/cwd-must-not-be-used", dir, { mode: "desktop" }),
    ServerSettings.layerTest({
      textGenerationModelSelection: selection,
      providerInstances: {
        [instanceId]: { driver: "codex", config: { apiKey: secret, projectRoot: "/private/repo" } },
      },
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({ getDescriptor: Effect.succeed(descriptor) }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([{ ...provider, enabled: !options.disabled }]),
      refresh: () =>
        Effect.sync(() => {
          refreshes += 1;
          return [provider];
        }),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed(options.missing ? undefined : instance),
    }),
    Layer.mock(TraceDiagnostics.TraceDiagnostics)({
      read: () => Effect.succeed(options.trace ?? trace()),
    }),
    Layer.succeed(TextGeneration.TextGeneration, generation),
    Layer.succeed(HelpIntegrations.HelpIntegrations, {
      snapshot: Effect.sync(() => {
        pluginReads += 1;
        return options.inventory ? options.inventory() : { integrations: [] };
      }),
    }),
    options.realDocumentation
      ? HelpDocumentation.layer
      : Layer.succeed(HelpDocumentation.HelpDocumentation, {
          search: (question, recentContext) =>
            Effect.sync(() => {
              documentationQuestions.push(question);
              documentationContexts.push(recentContext);
              return options.documentationUnavailable
                ? { documentationStatus: "unavailable" as const, documentation: [] }
                : {
                    documentationStatus: "available" as const,
                    documentation: [
                      {
                        title: "Computer use",
                        path: "docs/user/computer-use.md",
                        content: "Enable computer use in Settings > General.",
                      },
                    ],
                  };
            }),
        }),
  );
  return {
    dir,
    calls,
    refreshes: () => refreshes,
    pluginReads: () => pluginReads,
    documentationQuestions,
    documentationContexts,
    layer: Help.layer.pipe(Layer.provideMerge(dependencies)),
  };
});

const question = { messages: [{ role: "user" as const, content: "How do I verify this host?" }] };
const assertCode = (result: Result.Result<unknown, HelpError>, code: HelpError["code"]) => {
  assert.isTrue(Result.isFailure(result));
  if (Result.isFailure(result)) assert.equal(result.failure.code, code);
};

it.layer(NodeServices.layer)("Help", (it) => {
  it.effect(
    "retrieves shipped mouse setup and its permissions across the supplied Help conversation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ realDocumentation: true });
        yield* Effect.gen(function* () {
          const help = yield* Help.Help;
          const mouse = "i saw someone have their app use a mouse for them, how do i do that";
          const initial = yield* help.ask({ messages: [{ role: "user", content: mouse }] });
          const clarification = yield* help.ask({
            messages: [
              { role: "user", content: mouse },
              { role: "assistant", content: "You can control the mouse from the desktop app." },
              { role: "user", content: "is that not computer use?" },
            ],
          });
          const followup = yield* help.ask({
            messages: [
              { role: "user", content: mouse },
              { role: "assistant", content: "You can control the mouse from the desktop app." },
              { role: "user", content: "is that not computer use?" },
              {
                role: "assistant",
                content: "That is Computer use. Enable it in Settings > General.",
              },
              { role: "user", content: "What permissions do I need?" },
            ],
          });
          for (const result of [initial, clarification, followup]) {
            const guide = result.context.knowledge?.documentation.find(
              (doc) => doc.path === "docs/user/computer-use.md",
            );
            for (const instruction of [
              "Cua Driver",
              "Settings > General",
              "Accessibility",
              "Screen Recording",
              "Restart Harness",
              "local desktop backend",
              "Codex provider",
              "/computer-use",
            ])
              assert.include(guide?.content, instruction);
          }
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("retains the newest computer-use topic after many distinct older context terms", () =>
    Effect.gen(function* () {
      const h = yield* harness({ realDocumentation: true });
      const filler = Array.from({ length: 45 }, (_, index) => `filler${index}`).join(" ");
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Help.Help).ask({
          messages: [
            { role: "user", content: filler },
            {
              role: "assistant",
              content: "Use computer use in Settings > General to control the mouse.",
            },
            { role: "user", content: "What do I need to enable?" },
          ],
        });
      }).pipe(Effect.provide(h.layer));
      const guide = result.context.knowledge?.documentation.find(
        (doc) => doc.path === "docs/user/computer-use.md",
      );
      for (const instruction of [
        "Settings > General",
        "Accessibility",
        "Screen Recording",
        "Restart Harness",
      ])
        assert.include(guide?.content, instruction);
    }),
  );

  it.effect(
    "bounds and redacts recent retrieval context without adding old messages or client data",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* Effect.gen(function* () {
          yield* (yield* Help.Help).ask({
            messages: [
              { role: "user", content: "old-private-conversation" },
              {
                role: "user",
                content: `Use a mouse. api_key=${secret}\n${"x".repeat(6_000)}distant-private-tail`,
              },
              {
                role: "assistant",
                content: `Computer use. Cookie: session=private-cookie\n${"y".repeat(6_000)}`,
              },
              { role: "user", content: `What permissions do I need? api_key=${secret}` },
            ],
          });
        }).pipe(Effect.provide(h.layer));
        const context = h.documentationContexts[0]!;
        assert.isAtMost(context.length, 2_001);
        assert.include(context, "Use a mouse.");
        assert.include(context, "Computer use.");
        for (const value of [
          "old-private-conversation",
          "distant-private-tail",
          secret,
          "private-cookie",
        ])
          assert.notInclude(context, value);
        assert.notInclude(h.documentationQuestions[0]!, secret);
      }),
  );

  it.effect(
    "reads fresh host settings, cached plugin inventory and documentation for every snapshot and ask",
    () =>
      Effect.gen(function* () {
        let inventory: IntegrationsListResult | undefined = { integrations: [] };
        const h = yield* harness({ inventory: () => inventory });
        yield* Effect.gen(function* () {
          const help = yield* Help.Help;
          const settings = yield* ServerSettings.ServerSettingsService;
          const before = yield* help.getContext;
          assert.equal(before.knowledge?.pluginsStatus, "reported");
          assert.equal(before.knowledge?.documentationStatus, "available");
          assert.equal(
            before.knowledge?.settings.entries.find(
              (entry) => entry.key === "enableAgentDeviceAccess",
            )?.value,
            "false",
          );
          yield* settings.updateSettings({ enableAgentDeviceAccess: true });
          inventory = undefined;
          const after = yield* help.ask({
            messages: [{ role: "user", content: "How do I enable computer use?" }],
          });
          assert.equal(after.context.knowledge?.pluginsStatus, "unavailable");
          assert.equal(
            after.context.knowledge?.settings.entries.find(
              (entry) => entry.key === "enableAgentDeviceAccess",
            )?.value,
            "true",
          );
          assert.equal(h.pluginReads(), 2);
          assert.deepEqual(h.documentationQuestions, ["", "How do I enable computer use?"]);
          assert.deepEqual(h.calls[0]?.context, after.context);
          assert.isTrue(isHelpContext(after.context));
        }).pipe(Effect.provide(h.layer));
        assert.equal(h.refreshes(), 0);
      }),
  );

  it.effect(
    "sanitizes requesting-client reports and preserves desktop readiness separately from host state",
    () =>
      Effect.gen(function* () {
        const client: HelpClientContext = {
          surface: "desktop",
          platform: `macOS ${secret}`,
          settingsStatus: "ready",
          settings: {
            entries: [
              { key: "theme", value: "dark" },
              { key: "apiKey", value: "opaque-client-key", configured: true },
              { key: "custom", value: `Cookie: session=opaque-client-cookie` },
            ],
            totalCount: 3,
            omittedCount: 0,
          },
          settingsCatalog: [
            {
              id: "general",
              title: `General ${secret}`,
              route: "/settings/general",
              searchTerms: "computer use mouse accessibility",
              scope: "requesting client",
            },
          ],
          computerUse: {
            enabled: true,
            available: true,
            running: false,
            accessibilityPermission: false,
            screenRecordingPermission: null,
          },
        };
        const h = yield* harness();
        const result = yield* Effect.gen(function* () {
          return yield* (yield* Help.Help).ask({ ...question, client });
        }).pipe(Effect.provide(h.layer));
        assert.deepEqual(result.context.client?.computerUse, client.computerUse);
        assert.equal(result.context.platform, "linux/arm64");
        assert.equal(result.context.client?.surface, "desktop");
        assert.equal(result.context.client?.settings.entries[0]?.value, "dark");
        assert.equal(result.context.client?.settings.entries[1]?.value, "configured");
        assert.deepEqual(h.calls[0]?.context.client, result.context.client);
        for (const value of [secret, "opaque-client-key", "opaque-client-cookie"])
          assert.notInclude(JSON.stringify(result.context), value);
        assert.isTrue(isHelpContext(result.context));
      }),
  );

  it.effect("reports unavailable documentation independently of an otherwise usable snapshot", () =>
    Effect.gen(function* () {
      const h = yield* harness({ documentationUnavailable: true });
      const context = yield* Effect.gen(function* () {
        return yield* (yield* Help.Help).getContext;
      }).pipe(Effect.provide(h.layer));
      assert.equal(context.knowledge?.documentationStatus, "unavailable");
      assert.equal(context.knowledge?.pluginsStatus, "reported");
      assert.isUndefined(context.client);
      assert.lengthOf(h.calls, 0);
    }),
  );

  it.effect(
    "reads a bounded allowlisted snapshot without inference, live discovery or private payloads",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const context = yield* Effect.gen(function* () {
          return yield* (yield* Help.Help).getContext;
        }).pipe(Effect.provide(h.layer));
        assert.lengthOf(h.calls, 0);
        assert.equal(h.refreshes(), 0);
        assert.equal(context.environmentId, descriptor.environmentId);
        assert.equal(context.environmentName, descriptor.label);
        assert.equal(context.version, descriptor.serverVersion);
        assert.equal(context.platform, "linux/arm64");
        assert.equal(context.mode, "desktop");
        assert.include(context.paths[0]!.path, h.dir);
        assert.notInclude(JSON.stringify(context.paths), "/host/cwd-must-not-be-used");
        assert.equal(context.providers[0]?.authenticated, null);
        assert.equal(context.modelLabel, "Configured runtime / selected-support-model");
        assert.deepEqual(context.diagnostics, {
          recordCount: 15,
          failureCount: 7,
          slowSpanCount: 3,
          partial: false,
          recentFailures: Array.from({ length: 5 }, (_, index) => ({
            operation: index === 0 ? "ws.rpc.server.getSettings" : "other",
            category: "authentication",
            occurredAt: "2026-10-22T12:00:00.000Z",
          })),
        });
        for (const privateValue of [
          secret,
          "private@example.test",
          "/private/repo",
          "/private/provider-home",
          "private-trace-id",
          "raw user prompt",
          "raw log",
          "/private/raw.trace",
        ]) {
          assert.notInclude(JSON.stringify(context), privateValue);
        }
      }),
  );

  it.effect.each([
    { recordCount: 0 },
    { parseErrorCount: 2 },
    { partialFailure: Option.some(true) },
    { error: Option.some({ kind: "trace-file-not-found" as const, message: `private ${secret}` }) },
  ])("reports missing, empty and partial traces as incomplete evidence: %o", (override) =>
    Effect.gen(function* () {
      const h = yield* harness({ trace: trace(override) });
      const context = yield* Effect.gen(function* () {
        return yield* (yield* Help.Help).getContext;
      }).pipe(Effect.provide(h.layer));
      assert.isTrue(context.diagnostics.partial);
      assert.lengthOf(h.calls, 0);
      assert.notInclude(JSON.stringify(context), secret);
    }),
  );

  it.effect(
    "passes only supplied redacted history and snapshot to the configured model in an empty disposable cwd",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const h = yield* harness({
          generate: (input) =>
            Effect.gen(function* () {
              assert.deepEqual(yield* fs.readDirectory(input.cwd).pipe(Effect.orDie), []);
              assert.notEqual(input.cwd, "/host/cwd-must-not-be-used");
              return { answer: `Check Settings > General. ${secret}` };
            }),
        });
        const result = yield* Effect.gen(function* () {
          return yield* (yield* Help.Help).ask({
            messages: [
              { role: "user", content: `api_key=${secret} Authorization: Bearer privatevalue` },
              { role: "assistant", content: "Check which environment is connected." },
              { role: "user", content: "It is the remote server. What next?" },
            ],
          });
        }).pipe(Effect.provide(h.layer));
        assert.lengthOf(h.calls, 1);
        const call = h.calls[0]!;
        assert.deepEqual(call.modelSelection, selection);
        assert.deepEqual(
          call.messages.map((message) => message.role),
          ["user", "assistant", "user"],
        );
        assert.include(call.messages[0]!.content, "[REDACTED]");
        assert.notInclude(JSON.stringify(call), secret);
        assert.notInclude(JSON.stringify(call), "privatevalue");
        assert.equal(call.messages[2]!.content, "It is the remote server. What next?");
        assert.deepEqual(result.context, call.context);
        assert.notInclude(result.answer, secret);
        assert.isFalse(yield* fs.exists(call.cwd));
      }),
  );

  it.effect.each([
    { header: "Authorization: Basic YmFzaWMtc2VjcmV0", credential: "YmFzaWMtc2VjcmV0" },
    { header: "Proxy-Authorization: Basic cHJveHktc2VjcmV0", credential: "cHJveHktc2VjcmV0" },
    {
      header: "Cookie: session=opaque-cookie-secret; auth=another-cookie",
      credential: "opaque-cookie-secret",
    },
    { header: "Set-Cookie: session=opaque-set-cookie; HttpOnly", credential: "opaque-set-cookie" },
    { header: '"Authorization": "Basic cXVvdGVkLXNlY3JldA=="', credential: "cXVvdGVkLXNlY3JldA==" },
    { header: "GEMINI_API_KEY=gemini-secret-value", credential: "gemini-secret-value" },
    { header: "AWS_SECRET_ACCESS_KEY=aws-secret-value", credential: "aws-secret-value" },
    {
      header: "AWS_SESSION_TOKEN=aws-session-secret-value",
      credential: "aws-session-secret-value",
    },
    {
      header: '{"managementKey":"opaque-management-camel"}',
      credential: "opaque-management-camel",
    },
    {
      header: '{"management_key":"opaque-management-snake"}',
      credential: "opaque-management-snake",
    },
    { header: "management-key='opaque-management-dash'", credential: "opaque-management-dash" },
    { header: "management key: opaque-management-spaces", credential: "opaque-management-spaces" },
    {
      header: "USAGE_MANAGEMENT_KEY=opaque-management-prefixed",
      credential: "opaque-management-prefixed",
    },
  ])(
    "removes complete sensitive header credentials from model input and output: %o",
    ({ header, credential }) =>
      Effect.gen(function* () {
        const h = yield* harness({ generate: () => Effect.succeed({ answer: header }) });
        const result = yield* Effect.gen(function* () {
          return yield* (yield* Help.Help).ask({
            messages: [{ role: "user", content: `${header}\nWhy did sign-in fail?` }],
          });
        }).pipe(Effect.provide(h.layer));
        assert.notInclude(JSON.stringify(h.calls), credential);
        assert.notInclude(JSON.stringify(h.documentationQuestions), credential);
        assert.notInclude(result.answer, credential);
        assert.include(h.calls[0]!.messages[0]!.content, "Why did sign-in fail?");
        assert.include(result.answer, "[REDACTED]");
      }),
  );

  it.effect.each([
    { messages: [] },
    { messages: [{ role: "assistant" as const, content: "A previous suggestion" }] },
    { messages: [{ role: "user" as const, content: " " }] },
    { messages: [{ role: "user" as const, content: "x".repeat(8_001) }] },
    { messages: Array.from({ length: 21 }, () => ({ role: "user" as const, content: "hello" })) },
  ])("validates direct service callers before inference: %o", (input) =>
    Effect.gen(function* () {
      const h = yield* harness();
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Help.Help).ask(input);
      }).pipe(Effect.result, Effect.provide(h.layer));
      assertCode(result, "invalid_request");
      assert.lengthOf(h.calls, 0);
    }),
  );

  it.effect.each([
    { unsupported: true, expected: "unsupported" as const },
    { missing: true, expected: "unavailable" as const },
    { disabled: true, expected: "unavailable" as const },
  ])("refuses unavailable or unsupported configured providers before inference: %o", (options) =>
    Effect.gen(function* () {
      const h = yield* harness(options);
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Help.Help).ask(question);
      }).pipe(Effect.result, Effect.provide(h.layer));
      assertCode(result, options.expected);
      assert.lengthOf(h.calls, 0);
    }),
  );

  it.effect("returns a fixed safe failure instead of provider error text", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        generate: () =>
          Effect.fail(new TextGenerationError({ operation: "generateHelp", detail: secret })),
      });
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Help.Help).ask(question);
      }).pipe(Effect.result, Effect.provide(h.layer));
      assertCode(result, "generation_failed");
      if (Result.isFailure(result)) {
        assert.notInclude(result.failure.message, secret);
        assert.notProperty(result.failure, "cause");
      }
    }),
  );

  it.effect(
    "rejects concurrent inference, interrupts at the timeout and releases its budget and cwd",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const enteredAgain = yield* Deferred.make<void>();
        let generations = 0;
        const h = yield* harness({
          generate: () =>
            Effect.gen(function* () {
              generations += 1;
              yield* Deferred.succeed(generations === 1 ? entered : enteredAgain, undefined);
              return yield* Effect.never;
            }),
        });
        const fs = yield* FileSystem.FileSystem;
        yield* Effect.gen(function* () {
          const help = yield* Help.Help;
          const first = yield* help.ask(question).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(entered);
          assertCode(yield* help.ask(question).pipe(Effect.result), "busy");
          yield* TestClock.adjust("61 seconds");
          assertCode(yield* Fiber.join(first), "timeout");
          assert.isFalse(yield* fs.exists(h.calls[0]!.cwd));
          const second = yield* help.ask(question).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(enteredAgain);
          yield* TestClock.adjust("61 seconds");
          assertCode(yield* Fiber.join(second), "timeout");
          assert.lengthOf(h.calls, 2);
        }).pipe(Effect.provide(h.layer));
      }),
  );
});
