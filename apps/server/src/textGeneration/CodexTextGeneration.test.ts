import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { fromRunner } from "@t3tools/provider-core/server/textGenerationOperations";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";

import {
  CodexSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  TRITONAI_CODEX_MODEL_PROVIDER_ID,
  TextGenerationError,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TritonAiRequestAnalytics from "../telemetry/TritonAiRequestAnalytics.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import * as ExternalContent from "../integrations/ExternalContent.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import managedHarnessConfig from "../../../../config/tritonai-managed-config.json" with { type: "json" };
import { makeProcessProbe, processProbeSource } from "../testUtils/processProbe.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const NATIVE_AUTH_FIXTURE = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "synthetic-id-token",
    access_token: "synthetic-access-token",
    refresh_token: "synthetic-refresh-must-stay-with-owner",
    account_id: "synthetic-native-account",
  },
  last_refresh: "2020-01-01T00:00:00Z",
});

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const HELP_INPUT: import("@t3tools/provider-core/server/textGeneration").HelpGenerationInput = {
  cwd: "/must-not-read",
  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
  messages: [{ role: "user", content: "Read the host settings to fix my provider" }],
  context: {
    capturedAt: "2026-10-22T12:00:00.000Z",
    environmentId: EnvironmentId.make("help-test"),
    environmentName: "Test host",
    version: "test",
    platform: "linux",
    mode: "local",
    paths: [],
    providers: [],
    modelLabel: "Codex",
    diagnostics: {
      recordCount: 0,
      failureCount: 0,
      slowSpanCount: 0,
      partial: true,
      recentFailures: [],
    },
  },
};

const layerCodexTextGenerationTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-text-generation-test-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    ExternalContent.layer.pipe(
      Layer.provide(Layer.mergeAll(Sqlite.layerMemory, NodeServices.layer)),
    ),
  ),
);

interface FakeCodexInput {
  output: string;
  lifecycle?: { port: number; command: "exec" | "mcp list" | "app-server" };
  exitCode?: number;
  stderr?: string;
  requireImage?: boolean;
  forbidImage?: boolean;
  requireTritonAiProviderConfig?: boolean;
  requireServiceTier?: string;
  requireReasoningEffort?: string;
  forbidReasoningEffort?: boolean;
  requireArg?: string;
  forbidArg?: string;
  stdinMustContain?: string;
  stdinMustNotContain?: string;
  /** What `codex mcp list --json` answers; a number exits with that code instead. */
  mcpServers?: ReadonlyArray<{ name: string; enabled: boolean }> | number | string;
  unsupportedHelp?: boolean;
  requireHelpIsolation?: boolean;
  helpVersion?: string;
  requireNativeAuth?: boolean;
  nativeOwner?: "renew" | "fail";
  nativeTransportConfig?: Record<string, unknown> | "unavailable";
  forbidNativeAuth?: boolean;
}

function makeFakeCodexBinary(dir: string, input: FakeCodexInput) {
  const check = JSON.stringify({
    requireImage: input.requireImage ?? false,
    forbidImage: input.forbidImage ?? false,
    requireTritonAiProviderConfig: input.requireTritonAiProviderConfig ?? false,
    requireServiceTier: input.requireServiceTier ?? null,
    requireReasoningEffort: input.requireReasoningEffort ?? null,
    forbidReasoningEffort: input.forbidReasoningEffort ?? false,
    requireArg: input.requireArg ?? null,
    forbidArg: input.forbidArg ?? null,
    stdinMustContain: input.stdinMustContain ?? null,
    stdinMustNotContain: input.stdinMustNotContain ?? null,
    mcpServers: input.mcpServers ?? [],
    unsupportedHelp: input.unsupportedHelp ?? false,
    requireHelpIsolation: input.requireHelpIsolation ?? false,
    helpVersion: input.helpVersion ?? "0.156.1",
    requireNativeAuth: input.requireNativeAuth ?? false,
    nativeOwner: input.nativeOwner ?? null,
    nativeTransportConfig: input.nativeTransportConfig ?? { model_provider: "openai" },
    forbidNativeAuth: input.forbidNativeAuth ?? false,
    stderr: input.stderr ?? null,
    output: input.output,
    exitCode: input.exitCode ?? 0,
  });
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const callsPath = path.join(dir, "calls.jsonl");
    return writeFakeCli({
      directory: path.join(dir, "bin"),
      name: "codex",
      source: [
        'import * as NodeFS from "node:fs";',
        'import * as Readline from "node:readline";',
        `const check = ${check};`,
        "const args = process.argv.slice(2);",
        `NodeFS.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, cwd: process.cwd(), home: process.env.CODEX_HOME }) + "\\n");`,
        'if (args.includes("--version")) { process.stdout.write("codex-cli " + check.helpVersion); process.exit(0); }',
        'if (args.includes("exec") && args.includes("--help")) {',
        '  process.stdout.write(check.unsupportedHelp ? "Unsupported CLI" : "--ignore-user-config --ignore-rules --strict-config --output-schema");',
        "  process.exit(0);",
        "}",
        'if (args.includes("features") && args.includes("list")) {',
        '  process.stdout.write(["shell_tool", "view_image", "skip_host_skill_discovery", "plugins", "apps", "code_mode", "hooks", "multi_agent"].map(name => name + " stable false").join("\\n"));',
        "  process.exit(0);",
        "}",
        'if (args.includes("debug") && args.includes("models")) {',
        '  process.stdout.write(JSON.stringify({ models: [{ slug: "template", base_instructions: "PRIVATE CATALOG INSTRUCTIONS", shell_type: "default", apply_patch_tool_type: "freeform", experimental_supported_tools: ["clock"] }] }));',
        "  process.exit(0);",
        "}",
        'if (args.includes("app-server")) {',
        ...(input.lifecycle?.command !== "app-server"
          ? []
          : [
              'process.on("SIGTERM", () => {});',
              processProbeSource(input.lifecycle.port),
              "await new Promise(() => {});",
            ]),
        '  if (!process.env.CODEX_HOME.endsWith("native-home")) process.exit(31);',
        "  if (NodeFS.readdirSync(process.cwd()).length !== 0) process.exit(32);",
        '  if (args.join(" ").includes("PRIVATE LAUNCH INSTRUCTIONS")) process.exit(33);',
        '  const ownerLock = process.env.CODEX_HOME + "/owner-active";',
        '  try { NodeFS.closeSync(NodeFS.openSync(ownerLock,"wx")); } catch { process.exit(35); }',
        '  process.on("SIGTERM", () => { NodeFS.unlinkSync(ownerLock); process.exit(0); });',
        "  const lines = Readline.createInterface({ input: process.stdin });",
        "  for await (const line of lines) {",
        "    const request = JSON.parse(line);",
        '    if (request.method === "initialized") continue;',
        '    if (request.method === "initialize") {',
        '      process.stdout.write(JSON.stringify({id:request.id,result:{userAgent:"codex/0.156.1",codexHome:process.env.CODEX_HOME,platformFamily:"unix",platformOs:"linux"}}) + "\\n");',
        "      continue;",
        "    }",
        '    if (request.method === "config/read") {',
        '      if (check.nativeTransportConfig === "unavailable") { process.stdout.write(JSON.stringify({id:request.id,error:{code:-32603,message:"synthetic private config failure"}}) + "\\n"); continue; }',
        "      const config = structuredClone(check.nativeTransportConfig);",
        '      for (const arg of args) if (arg.startsWith("model_provider=")) config.model_provider = JSON.parse(arg.slice("model_provider=".length));',
        "      for (const arg of args) { const match = /^model_providers\\.([A-Za-z0-9_-]+)\\.([a-z_]+)=(.*)$/.exec(arg); if (!match) continue; let value; try { value = JSON.parse(match[3]); } catch { value = match[3].replace(/^'(.*)'$/, \"$1\"); } ((config.model_providers ??= {})[match[1]] ??= {})[match[2]] = value; }",
        '      process.stdout.write(JSON.stringify({id:request.id,result:{config,origins:{}}}) + "\\n");',
        "      continue;",
        "    }",
        '    if (request.method !== "getAuthStatus" || request.params.includeToken !== false || request.params.refreshToken !== false) process.exit(34);',
        '    if (check.nativeOwner === "fail") { process.stdout.write(JSON.stringify({id:request.id,error:{code:-32603,message:"synthetic private auth failure"}}) + "\\n"); continue; }',
        '    if (check.nativeOwner === "renew") {',
        '      const authPath = process.env.CODEX_HOME + "/auth.json";',
        '      const auth = JSON.parse(NodeFS.readFileSync(authPath,"utf8"));',
        '      auth.tokens.access_token = "synthetic-renewed-access-token";',
        '      auth.tokens.refresh_token = "synthetic-rotated-refresh-retained";',
        "      auth.last_refresh = new Date().toISOString();",
        "      NodeFS.writeFileSync(authPath,JSON.stringify(auth));",
        "    }",
        '    process.stdout.write(JSON.stringify({id:request.id,result:{authMethod:"chatgpt",authToken:null,requiresOpenaiAuth:true}}) + "\\n");',
        "  }",
        "  process.exit(0);",
        "}",
        'const isMcpList = args.includes("mcp") && args.includes("list");',
        ...(input.lifecycle === undefined
          ? []
          : [
              `if (isMcpList === ${input.lifecycle.command === "mcp list"}) {`,
              'process.on("SIGTERM", () => {});',
              processProbeSource(input.lifecycle.port),
              "await new Promise(() => {});",
              "}",
            ]),
        "if (isMcpList) {",
        '  if (typeof check.mcpServers === "number") process.exit(check.mcpServers);',
        '  process.stdout.write(typeof check.mcpServers === "string" ? check.mcpServers : JSON.stringify(check.mcpServers));',
        "  process.exit(0);",
        "}",
        'const originalArgs = ` ${args.join(" ")} `;',
        "let outputPath = null;",
        "let seenImage = false;",
        'let seenServiceTier = "";',
        'let seenReasoningEffort = "";',
        "for (let index = 0; index < args.length; index += 1) {",
        '  if (args[index] === "--image") {',
        "    index += 1;",
        "    if (args[index]) seenImage = true;",
        '  } else if (args[index] === "--config") {',
        "    index += 1;",
        '    const value = args[index] ?? "";',
        '    if (value.startsWith("service_tier=")) seenServiceTier = value;',
        '    if (value.startsWith("model_reasoning_effort=")) seenReasoningEffort = value;',
        '  } else if (args[index] === "--output-last-message") {',
        "    index += 1;",
        "    outputPath = args[index] ?? null;",
        "  }",
        "}",
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        'const stdinContent = Buffer.concat(chunks).toString("utf8");',
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "if (check.requireHelpIsolation) {",
        '  for (const flag of ["--ignore-user-config", "--ignore-rules", "--strict-config"]) if (!args.includes(flag)) fail("missing isolation flag " + flag, 10);',
        '  if (args.includes("-s") || args.includes("--sandbox")) fail("sandbox flag overrides named Help profile", 11);',
        '  if (NodeFS.readdirSync(process.cwd()).length !== 0) fail("Help cwd must be empty", 12);',
        '  if (originalArgs.includes("PRIVATE LAUNCH INSTRUCTIONS")) fail("arbitrary overrides reached Help", 13);',
        '  const catalogArg = args.find(value => value.startsWith("model_catalog_json="));',
        '  const catalog = JSON.parse(NodeFS.readFileSync(JSON.parse(catalogArg.slice("model_catalog_json=".length)), "utf8"));',
        "  const model = catalog.models[0];",
        '  if (model.shell_type !== "disabled" || model.apply_patch_tool_type !== null || model.experimental_supported_tools.length !== 0 || model.supports_search_tool !== false) fail("unsafe model tools", 14);',
        '  if (model.base_instructions.includes("PRIVATE CATALOG INSTRUCTIONS")) fail("catalog instructions reached Help", 15);',
        '  if (!originalArgs.includes(\' default_permissions="help" \') || originalArgs.includes(\'"write"\')) fail("unsafe Help profile", 16);',
        '  if (originalArgs.includes("model_provider=tritonai") && originalArgs.includes("model_provider=openai_token_sharing")) fail("managed provider was replaced", 17);',
        "}",
        "if (check.requireNativeAuth) {",
        "  const home = process.env.CODEX_HOME;",
        '  if (NodeFS.readdirSync(home).join(",") !== "auth.json") fail("copied native context beyond auth", 18);',
        '  if ((NodeFS.statSync(home + "/auth.json").mode & 0o777) !== 0o600) fail("auth mode must be 600", 19);',
        '  if (!originalArgs.includes(\' model_provider="openai" \')) fail("native OAuth provider changed", 20);',
        '  const auth = JSON.parse(NodeFS.readFileSync(home + "/auth.json", "utf8"));',
        '  if (auth.tokens.refresh_token !== "") fail("refresh grant escaped the credential owner", 22);',
        '  if (auth.tokens.access_token !== (check.nativeOwner === "renew" ? "synthetic-renewed-access-token" : "synthetic-access-token") || auth.tokens.account_id !== "synthetic-native-account") fail("native account changed or expired access reused", 23);',
        "}",
        'if (check.forbidNativeAuth && NodeFS.existsSync(process.env.CODEX_HOME + "/auth.json")) fail("native auth must not replace selected transport", 21);',
        "if (check.requireArg !== null && !originalArgs.includes(` ${check.requireArg} `)) {",
        '  fail("missing arg: " + check.requireArg, 8);',
        "}",
        "if (check.forbidArg !== null && originalArgs.includes(` ${check.forbidArg} `)) {",
        '  fail("forbidden arg: " + check.forbidArg, 9);',
        "}",
        'if (check.requireImage && !seenImage) fail("missing --image input", 2);',
        "if (",
        "  check.requireServiceTier !== null &&",
        '  seenServiceTier !== `service_tier="${check.requireServiceTier}"`',
        ") {",
        '  fail("unexpected service tier config: " + seenServiceTier, 5);',
        "}",
        "if (",
        "  check.requireReasoningEffort !== null &&",
        '  seenReasoningEffort !== `model_reasoning_effort="${check.requireReasoningEffort}"`',
        ") {",
        '  fail("unexpected reasoning effort config: " + seenReasoningEffort, 6);',
        "}",
        "if (check.forbidReasoningEffort && seenReasoningEffort.length > 0) {",
        '  fail("reasoning effort config should be omitted: " + seenReasoningEffort, 7);',
        "}",
        "if (check.stdinMustContain !== null && !stdinContent.includes(check.stdinMustContain)) {",
        '  fail("stdin missing expected content", 3);',
        "}",
        "if (check.stdinMustNotContain !== null && stdinContent.includes(check.stdinMustNotContain)) {",
        '  fail("stdin contained forbidden content", 4);',
        "}",
        'if (check.stderr !== null) process.stderr.write(check.stderr + "\\n");',
        'if (outputPath !== null) NodeFS.writeFileSync(outputPath, check.output + "\\n");',
        "process.exitCode = check.exitCode;",
        "",
      ].join("\n"),
    });
  });
}

function withFakeCodexEnv<A, E, R>(
  input: FakeCodexInput & {
    launchArgs?: string;
    environment?: NodeJS.ProcessEnv;
    models?: ReadonlyArray<string>;
    configOverrides?: Partial<CodexSettings>;
    managedRuntime?: boolean;
    nativeAuth?: boolean;
    nativePin?: ServerConfig.ServerConfig["Service"]["integrationCodexRuntime"];
    nativeLaunches?: Array<ReadonlyArray<string>>;
  },
  effectFn: (
    textGeneration: TextGeneration.TextGeneration["Service"],
    callsPath: string,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const path = yield* Path.Path;
    const nativeHome = path.join(tempDir, "native-home");
    if (input.nativeAuth) {
      yield* fs.makeDirectory(nativeHome);
      yield* fs.writeFileString(path.join(nativeHome, "auth.json"), NATIVE_AUTH_FIXTURE);
      yield* fs.writeFileString(
        path.join(nativeHome, "config.toml"),
        "PRIVATE CONFIG MUST NOT COPY",
      );
      yield* fs.writeFileString(
        path.join(nativeHome, "AGENTS.md"),
        "PRIVATE INSTRUCTIONS MUST NOT COPY",
      );
      yield* fs.writeFileString(
        path.join(nativeHome, "history.jsonl"),
        "PRIVATE HISTORY MUST NOT COPY",
      );
      yield* fs.chmod(path.join(nativeHome, "auth.json"), 0o644);
    }
    const config = decodeCodexSettings({
      ...input.configOverrides,
      ...(input.nativeAuth ? { homePath: nativeHome } : {}),
      binaryPath: codexPath,
      launchArgs:
        input.launchArgs ?? (input.managedRuntime ? '-c model_provider="test"' : undefined),
    });
    const serverConfig = yield* ServerConfig.ServerConfig;
    const baseSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) => {
      if (
        input.nativeLaunches &&
        ChildProcess.isStandardCommand(command) &&
        command.command.endsWith("/codex-app-server")
      ) {
        input.nativeLaunches.push(command.args);
        return Effect.die("Synthetic interceptor: no native process execution");
      }
      return baseSpawner.spawn(command);
    });
    const textGeneration = yield* makeCodexTextGeneration(
      config,
      input.environment === undefined ? undefined : { ...process.env, ...input.environment },
      Effect.succeed(
        (input.models ?? []).map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
      ),
      input.managedRuntime
        ? Effect.succeed({
            config,
            environment: input.environment ?? process.env,
            revision: "test",
          })
        : undefined,
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(ServerConfig.ServerConfig, {
        ...serverConfig,
        ...(input.nativePin ? { integrationCodexRuntime: input.nativePin } : {}),
      }),
    );
    return yield* effectFn(textGeneration, (yield* Path.Path).join(tempDir, "calls.jsonl"));
  }).pipe(Effect.scoped);
}

it.layer(layerCodexTextGenerationTest)("CodexTextGeneration", (it) => {
  it.effect.each(["native", "custom", "managed"] as const)(
    "native-pin Help preserves selected %s transport over ambient gateway credentials",
    (route) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const binaryPath = (yield* Path.Path).join(root, "inert-native-runtime");
        yield* fs.writeFileString(binaryPath, "x");
        const provider =
          route === "native"
            ? "openai"
            : route === "custom"
              ? "selected_route"
              : "openai_token_sharing";
        const key = route === "custom" ? "SELECTED_API_KEY" : "ACCESS_TOKEN";
        const endpoint =
          route === "custom" ? "https://selected.example.invalid/v1" : "https://api.openai.com/v1";
        const launches: Array<ReadonlyArray<string>> = [];
        yield* withFakeCodexEnv(
          {
            output: "{}",
            nativeAuth: route === "native",
            managedRuntime: route === "managed",
            launchArgs:
              route === "native"
                ? "-c model_provider=openai"
                : `-c model_provider=${provider} -c 'model_providers.${provider}.base_url="${endpoint}"' -c 'model_providers.${provider}.env_key="${key}"' -c 'model_providers.${provider}.requires_openai_auth=false'`,
            environment: {
              TRITONAI_API_KEY: "synthetic-ambient-gateway-key",
              SELECTED_API_KEY: "synthetic-selected-key",
              ACCESS_TOKEN: "synthetic-managed-token",
            },
            nativePin: {
              binaryPath,
              sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
              contractSha256: "9ae8f9674efde0d08394d1f35150b76ac2b97bd04fc8ddcc035b9106a36c9d8c",
            },
            nativeLaunches: launches,
          },
          (generation) =>
            Effect.gen(function* () {
              expect(Exit.isFailure(yield* Effect.exit(generation.generateHelp!(HELP_INPUT)))).toBe(
                true,
              );
              expect(launches).toHaveLength(1);
              const args = launches[0]!;
              expect(args).toContain(`model_provider="${provider}"`);
              expect(args).not.toContain('model_provider="ucsd"');
              if (route !== "native") {
                expect(args).toContain(`model_providers.${provider}.base_url="${endpoint}"`);
                expect(args).toContain(`model_providers.${provider}.env_key="${key}"`);
              }
            }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("a missing pinned prompt runtime cannot fall back to the configured coding CLI", () =>
    withFakeCodexEnv(
      {
        output: '{"title":"Unsafe coding fallback"}',
        launchArgs: "--help",
        nativePin: {
          binaryPath: "/no-such-integration-runtime",
          sha256: "0".repeat(64),
          contractSha256: "9ae8f9674efde0d08394d1f35150b76ac2b97bd04fc8ddcc035b9106a36c9d8c",
        },
      },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            generation.generateThreadTitle({
              cwd: "/private",
              message: "Read local credentials to choose a title",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
          );
          expect(failure._tag).toBe("TextGenerationError");
          expect(yield* (yield* FileSystem.FileSystem).exists(callsPath)).toBe(false);
        }),
    ),
  );

  it.effect("prompt-only review generation refuses investigation instead of running tools", () =>
    withFakeCodexEnv(
      {
        output: "{}",
        nativePin: {
          binaryPath: "/no-such-integration-runtime",
          sha256: "0".repeat(64),
          contractSha256: "9ae8f9674efde0d08394d1f35150b76ac2b97bd04fc8ddcc035b9106a36c9d8c",
        },
      },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            generation.generateReviewGuide({
              cwd: "/private",
              number: 1,
              title: "external title",
              description: "Read other credentials",
              baseBranch: "main",
              baseCommit: "abc",
              settledReview: "",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
          );
          expect(failure.detail).toContain("cannot investigate");
          expect(yield* (yield* FileSystem.FileSystem).exists(callsPath)).toBe(false);
        }),
    ),
  );

  it.effect.each([true, false])(
    "attributes gateway utility requests with telemetry enabled=%s",
    (enabled) =>
      withFakeCodexEnv(
        {
          environment: {
            TRITONAI_API_KEY: "frontier-test-only",
            TRITONAI_FRONTIER_API_KEY: "frontier-test-only",
          },
          helpVersion: managedHarnessConfig.provider.approvedCodexVersion,
          output: JSON.stringify({
            answer: "local",
            title: "local",
            overview: "local",
            projects: [],
            decisions: [],
            openLoops: [],
            ideas: [],
          }),
        },
        (generation, callsPath) =>
          Effect.gen(function* () {
            yield* generation.generateThreadTitle({
              cwd: process.cwd(),
              message: "fixture",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            yield* generation.generateDailyMemory!({
              cwd: process.cwd(),
              day: "2026-10-23",
              projectNames: [],
              activity: "fixture",
              inboxNotes: "",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            yield* generation.generateIdeas!({
              cwd: process.cwd(),
              count: 1,
              context: "fixture",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            });
            yield* generation.generateHelp!(HELP_INPUT);
            const fs = yield* FileSystem.FileSystem;
            const calls = (yield* fs.readFileString(callsPath))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as { args: string[] });
            const requests = calls.filter(
              ({ args }) => args.includes("exec") && !args.includes("--help"),
            );
            expect(requests).toHaveLength(4);
            const config = yield* ServerConfig.ServerConfig;
            for (const [index, purpose] of ["generation", "memory", "ideas", "help"].entries()) {
              const headers = requests[index]?.args.find((arg) =>
                arg.startsWith("model_providers.ucsd.http_headers="),
              );
              expect(headers).toContain('"X-TritonAI-Client"="harness"');
              if (enabled) {
                const installId = (yield* fs.readFileString(config.anonymousIdPath)).trim();
                expect(headers).toContain(`purpose:${purpose}`);
                expect(headers).toContain(`harness-install:${installId}`);
              } else {
                expect(headers).not.toContain("x-litellm-");
              }
            }
          }),
      ).pipe(
        Effect.provide(
          TritonAiRequestAnalytics.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: enabled }),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect("supports the managed policy's approved Codex version for isolated Help", () =>
    withFakeCodexEnv(
      {
        output: '{"answer":"Approved managed runtime Help works."}',
        managedRuntime: true,
        helpVersion: managedHarnessConfig.provider.approvedCodexVersion,
        requireHelpIsolation: true,
      },
      (generation) =>
        Effect.gen(function* () {
          const result = yield* generation.generateHelp!(HELP_INPUT);
          expect(result.answer).toBe("Approved managed runtime Help works.");
        }),
    ),
  );

  it.effect(
    "reuses current native access without sharing refresh grants or changing the owner",
    () =>
      withFakeCodexEnv(
        {
          output: '{"answer":"Native ChatGPT Help works."}',
          nativeAuth: true,
          environment: { TRITONAI_API_KEY: "" },
          requireNativeAuth: true,
          requireHelpIsolation: true,
        },
        (generation, callsPath) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const sourceHome = path.join(path.dirname(callsPath), "native-home");
            const result = yield* generation.generateHelp!(HELP_INPUT);
            expect(result.answer).toBe("Native ChatGPT Help works.");
            expect((yield* generation.generateHelp!(HELP_INPUT)).answer).toBe(result.answer);
            expect(yield* fs.readFileString(path.join(sourceHome, "auth.json"))).toBe(
              NATIVE_AUTH_FIXTURE,
            );
            expect((yield* fs.stat(path.join(sourceHome, "auth.json"))).mode & 0o777).toBe(0o644);
            expect((yield* fs.readDirectory(sourceHome)).sort()).toEqual([
              "AGENTS.md",
              "auth.json",
              "config.toml",
              "history.jsonl",
            ]);
            const calls = (yield* fs.readFileString(callsPath))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as { home: string; args: string[] })
              .filter((call) => !call.args.includes("app-server"));
            const homes = new Set(calls.map((call) => call.home));
            expect(homes.size).toBe(2);
            for (const home of homes) expect(yield* fs.exists(home)).toBe(false);
          }),
      ),
  );

  it.effect("keeps the home-configured transport instead of sending Help to native OpenAI", () =>
    withFakeCodexEnv(
      {
        output: '{"answer":"On-premises Help works."}',
        nativeAuth: true,
        nativeTransportConfig: {
          model_provider: "onprem",
          model_providers: {
            onprem: {
              name: "On-premises",
              base_url: "http://127.0.0.1:4444/v1",
              env_key: "HELP_ONPREM_KEY",
              wire_api: "responses",
              requires_openai_auth: false,
            },
          },
          developer_instructions: "PRIVATE CONFIG INSTRUCTIONS",
        },
        environment: { TRITONAI_API_KEY: "", HELP_ONPREM_KEY: "synthetic-onprem-key" },
        forbidNativeAuth: true,
        requireHelpIsolation: true,
        requireArg: 'model_provider="onprem"',
        stdinMustNotContain: "PRIVATE CONFIG INSTRUCTIONS",
      },
      (generation) =>
        Effect.gen(function* () {
          expect((yield* generation.generateHelp!(HELP_INPUT)).answer).toBe(
            "On-premises Help works.",
          );
        }),
    ),
  );

  it.effect(
    "rejects unavailable transport discovery before native authentication or inference",
    () =>
      withFakeCodexEnv(
        {
          output: '{"answer":"Must not run."}',
          nativeAuth: true,
          nativeTransportConfig: "unavailable",
          environment: { TRITONAI_API_KEY: "" },
        },
        (generation, callsPath) =>
          Effect.gen(function* () {
            const result = yield* generation.generateHelp!(HELP_INPUT).pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
            expect(JSON.stringify(result)).not.toContain("synthetic private config failure");
            const fs = yield* FileSystem.FileSystem;
            const calls = (yield* fs.readFileString(callsPath))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as { args: string[] });
            expect(calls.some((call) => call.args.includes("--output-last-message"))).toBe(false);
            expect(
              calls.some((call) => call.args.includes('cli_auth_credentials_store="file"')),
            ).toBe(false);
          }),
      ),
  );

  it.effect("honors an environment-selected transport without admitting its tool overrides", () =>
    withFakeCodexEnv(
      {
        output: '{"answer":"Environment endpoint works."}',
        nativeAuth: true,
        launchArgs: '-c model_provider="openai"',
        environment: {
          TRITONAI_API_KEY: "",
          T3CODE_CODEX_LAUNCH_ARGS:
            '-c model_provider="env_route" -c model_providers.env_route.base_url="https://selected.example.invalid/v1" -c features.shell_tool=true',
        },
        forbidNativeAuth: true,
        requireHelpIsolation: true,
        requireArg: 'model_provider="env_route"',
        forbidArg: "features.shell_tool=true",
      },
      (generation) =>
        Effect.gen(function* () {
          expect((yield* generation.generateHelp!(HELP_INPUT)).answer).toBe(
            "Environment endpoint works.",
          );
        }),
    ),
  );

  it.effect("renews native access through the owner and retains its rotated refresh grant", () =>
    withFakeCodexEnv(
      {
        output: '{"answer":"Renewed native Help works."}',
        nativeAuth: true,
        environment: { TRITONAI_API_KEY: "" },
        requireNativeAuth: true,
        requireHelpIsolation: true,
        nativeOwner: "renew",
      },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sourceHome = path.join(path.dirname(callsPath), "native-home");
          expect((yield* generation.generateHelp!(HELP_INPUT)).answer).toBe(
            "Renewed native Help works.",
          );
          const owner = JSON.parse(yield* fs.readFileString(path.join(sourceHome, "auth.json")));
          expect(owner.tokens.access_token).toBe("synthetic-renewed-access-token");
          expect(owner.tokens.refresh_token).toBe("synthetic-rotated-refresh-retained");
          const calls = (yield* fs.readFileString(callsPath))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { home: string; args: string[] });
          expect(
            calls.filter((call) => call.args.includes("app-server")).map((call) => call.home),
          ).toEqual([yield* fs.realPath(sourceHome), yield* fs.realPath(sourceHome)]);
          for (const call of calls.filter((call) => !call.args.includes("app-server")))
            expect(yield* fs.exists(call.home)).toBe(false);
        }),
    ),
  );

  it.effect("fails closed when the native owner cannot prepare access", () =>
    withFakeCodexEnv(
      {
        output: '{"answer":"Must not run."}',
        nativeAuth: true,
        environment: { TRITONAI_API_KEY: "" },
        requireNativeAuth: true,
        nativeOwner: "fail",
      },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const result = yield* generation.generateHelp!(HELP_INPUT).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          expect(JSON.stringify(result)).not.toContain("synthetic private auth failure");
          const calls = (yield* fs.readFileString(callsPath))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[] });
          expect(calls.some((call) => call.args.includes("app-server"))).toBe(true);
          expect(calls.some((call) => call.args.includes("--output-last-message"))).toBe(false);
        }),
    ),
  );

  it.effect("serializes concurrent native renewals against the same canonical owner", () =>
    withFakeCodexEnv(
      {
        output: '{"answer":"Fresh access."}',
        nativeAuth: true,
        environment: { TRITONAI_API_KEY: "" },
        requireNativeAuth: true,
        requireHelpIsolation: true,
        nativeOwner: "renew",
      },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const results = yield* Effect.all(
            [generation.generateHelp!(HELP_INPUT), generation.generateHelp!(HELP_INPUT)],
            { concurrency: "unbounded" },
          );
          expect(results.map((result) => result.answer)).toEqual([
            "Fresh access.",
            "Fresh access.",
          ]);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sourceHome = path.join(path.dirname(callsPath), "native-home");
          expect(yield* fs.exists(path.join(sourceHome, "owner-active"))).toBe(false);
          const owner = JSON.parse(yield* fs.readFileString(path.join(sourceHome, "auth.json")));
          expect(owner.tokens.refresh_token).toBe("synthetic-rotated-refresh-retained");
        }),
    ),
  );

  it.effect("reaps a stalled native auth owner when Help is interrupted", () =>
    Effect.gen(function* () {
      const probe = yield* makeProcessProbe;
      yield* withFakeCodexEnv(
        {
          output: "",
          nativeAuth: true,
          environment: { TRITONAI_API_KEY: "" },
          lifecycle: { port: probe.port, command: "app-server" },
        },
        (generation) =>
          Effect.gen(function* () {
            const fiber = yield* generation.generateHelp!(HELP_INPUT).pipe(Effect.forkScoped);
            yield* probe.started;
            const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
            yield* probe.exited;
            yield* Fiber.join(interrupted);
            const exit = yield* Fiber.await(fiber);
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          }),
      );
    }),
  );

  it.effect("keeps the configured gateway when native authentication also exists", () =>
    withFakeCodexEnv(
      {
        output: '{"answer":"Gateway Help works."}',
        nativeAuth: true,
        forbidNativeAuth: true,
        requireHelpIsolation: true,
        helpVersion: managedHarnessConfig.provider.approvedCodexVersion,
        environment: {
          TRITONAI_API_KEY: "synthetic-gateway-key",
          UCSD_AI_BASE_URL: "https://on-prem.example.invalid/v1",
        },
      },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const result = yield* generation.generateHelp!(HELP_INPUT);
          expect(result.answer).toBe("Gateway Help works.");
          const calls = (yield* fs.readFileString(callsPath))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[] });
          const inference = calls.find(
            (call) => call.args[0] === "exec" && !call.args.includes("--help"),
          );
          expect(inference).toBeDefined();
          expect(inference!.args.filter((arg) => arg.startsWith("model_provider="))).toEqual([
            `model_provider="${TRITONAI_CODEX_MODEL_PROVIDER_ID}"`,
          ]);
          expect(inference!.args).toContain(
            `model_providers.${TRITONAI_CODEX_MODEL_PROVIDER_ID}.base_url="https://on-prem.example.invalid/v1"`,
          );
          expect(inference!.args).toContain(
            `model_providers.${TRITONAI_CODEX_MODEL_PROVIDER_ID}.env_key="TRITONAI_API_KEY"`,
          );
        }),
    ),
  );

  it.effect.each([
    "-c model_provider=openai",
    '-c model_provider="openai"',
    `--config 'model_provider="openai"'`,
    `--config="model_provider='openai'"`,
    "--config=model_provider=openai",
    "-c=model_provider=openai",
    `-c 'model_provider="old_route"' --config=model_provider=openai`,
    "-c model_provider={} --config=model_provider=openai",
    "-c model_provider=true --config=model_provider=openai",
    "-c model_provider.nested=selected_route --config=model_provider=openai",
    `-c model_provider=openai -c 'model_providers.unused.base_url="https://unused.example.invalid/v1"'`,
    `-c 'model_providers.unused.env_key="UNUSED_API_KEY"' -c model_provider=openai`,
  ])("explicitly selects native auth over ambient gateway credentials (%s)", (launchArgs) =>
    withFakeCodexEnv(
      {
        output: '{"answer":"Selected native account works."}',
        nativeAuth: true,
        requireNativeAuth: true,
        requireHelpIsolation: true,
        launchArgs,
        environment: { TRITONAI_API_KEY: "synthetic-gateway-key" },
      },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          expect((yield* generation.generateHelp!(HELP_INPUT)).answer).toBe(
            "Selected native account works.",
          );
          const calls = (yield* fs.readFileString(callsPath))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[]; home: string });
          const inference = calls.find(
            (call) => call.args[0] === "exec" && !call.args.includes("--help"),
          );
          expect(inference!.args.findLast((arg) => arg.startsWith("model_provider="))).toBe(
            'model_provider="openai"',
          );
          expect(inference!.args.some((arg) => arg.startsWith("model_providers."))).toBe(false);
          expect(yield* fs.exists(inference!.home)).toBe(false);
        }),
    ),
  );

  it.effect("never copies native auth when custom OpenAI transport precedes the selector", () =>
    withFakeCodexEnv(
      {
        output: '{"answer":"Custom OpenAI transport works."}',
        nativeAuth: true,
        forbidNativeAuth: true,
        requireHelpIsolation: true,
        launchArgs: `-c 'model_providers.openai.base_url="https://selected.example.invalid/v1"' -c 'model_providers.openai.env_key="SELECTED_API_KEY"' -c model_provider=openai`,
        environment: {
          TRITONAI_API_KEY: "synthetic-gateway-key",
          SELECTED_API_KEY: "synthetic-selected-key",
        },
        requireArg: 'model_providers.openai.base_url="https://selected.example.invalid/v1"',
      },
      (generation) =>
        Effect.gen(function* () {
          expect((yield* generation.generateHelp!(HELP_INPUT)).answer).toBe(
            "Custom OpenAI transport works.",
          );
        }),
    ),
  );

  it.effect.each([
    { flag: "--config ", provider: "selected_route" },
    { flag: "--config=", provider: "selected_route" },
    { flag: "-c=", provider: "selected_route" },
    { flag: "-c ", provider: TRITONAI_CODEX_MODEL_PROVIDER_ID },
    { flag: "-c ", provider: "openai" },
  ])(
    "preserves an explicitly selected transport with mixed credentials ($flag $provider)",
    ({ flag, provider }) =>
      withFakeCodexEnv(
        {
          output: '{"answer":"Selected endpoint Help works."}',
          nativeAuth: true,
          forbidNativeAuth: true,
          requireHelpIsolation: true,
          launchArgs: `${flag}'model_provider="${provider}"' ${flag}'model_providers.${provider}.base_url="https://selected.example.invalid/v1"' ${flag}'model_providers.${provider}.env_key="SELECTED_API_KEY"'`,
          environment: {
            TRITONAI_API_KEY: "synthetic-gateway-key",
            SELECTED_API_KEY: "synthetic-selected-key",
          },
        },
        (generation, callsPath) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            expect((yield* generation.generateHelp!(HELP_INPUT)).answer).toBe(
              "Selected endpoint Help works.",
            );
            const calls = (yield* fs.readFileString(callsPath))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as { args: string[] });
            const inference = calls.find(
              (call) => call.args[0] === "exec" && !call.args.includes("--help"),
            );
            expect(inference!.args.filter((arg) => arg.startsWith("model_provider="))).toEqual([
              `model_provider="${provider}"`,
            ]);
            expect(inference!.args).toContain(
              `model_providers.${provider}.base_url="https://selected.example.invalid/v1"`,
            );
            expect(inference!.args).toContain(
              `model_providers.${provider}.env_key="SELECTED_API_KEY"`,
            );
          }),
      ),
  );

  it.effect("honors the last explicit selector across split and compact overrides", () =>
    withFakeCodexEnv(
      {
        output: '{"answer":"Last selected route works."}',
        nativeAuth: true,
        forbidNativeAuth: true,
        requireHelpIsolation: true,
        launchArgs: `-c 'model_provider="openai"' --config='model_provider="selected_route"' -c 'model_providers.selected_route.base_url="https://selected.example.invalid/v1"'`,
        environment: { TRITONAI_API_KEY: "synthetic-gateway-key" },
      },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          expect((yield* generation.generateHelp!(HELP_INPUT)).answer).toBe(
            "Last selected route works.",
          );
          const calls = (yield* fs.readFileString(callsPath))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[] });
          const inference = calls.find(
            (call) => call.args[0] === "exec" && !call.args.includes("--help"),
          );
          expect(inference!.args.findLast((arg) => arg.startsWith("model_provider="))).toBe(
            'model_provider="selected_route"',
          );
          expect(inference!.args).toContain(
            'model_providers.selected_route.base_url="https://selected.example.invalid/v1"',
          );
        }),
    ),
  );

  it.effect.each([
    "--profile private",
    "--profile=private",
    "-pprivate",
    "--oss",
    "--local-provider ollama",
    "--remote wss://example.invalid",
    "--cd /private/project",
    '-c profile="private"',
  ])(
    "rejects unsupported configuration-source selectors before any CLI request: %s",
    (launchArgs) =>
      withFakeCodexEnv(
        {
          output: '{"answer":"Must not run."}',
          nativeAuth: true,
          launchArgs,
          environment: { TRITONAI_API_KEY: "" },
        },
        (generation, callsPath) =>
          Effect.gen(function* () {
            expect(
              Result.isFailure(yield* generation.generateHelp!(HELP_INPUT).pipe(Effect.result)),
            ).toBe(true);
            const fs = yield* FileSystem.FileSystem;
            expect(yield* fs.exists(callsPath)).toBe(false);
          }),
      ),
  );

  it.effect.each([
    '-c model_providers.selected_route.base_url="https://selected.example.invalid/v1"',
    '--config=model_providers={openai={base_url="https://selected.example.invalid/v1"}}',
    '-c model_provider="selected_route" --config=model_providers.selected_route={base_url="https://selected.example.invalid/v1"}',
    "-c model_provider=true",
    "-c model_provider={}",
    "-c model_provider=openai --config=model_provider=true",
    "-c model_provider=openai --config=model_provider={}",
    "-c model_provider=",
    "-c model_provider",
    `-c 'model_provider="open\\u0061i"'`,
    `-c 'model_provider="openai'`,
    "-c model_provider=openai -c model_provider.nested=selected_route",
    "-c model_provider=openai -c openai_base_url=https://selected.example.invalid/v1",
    "-c model_provider=openai -c chatgpt_base_url=https://selected.example.invalid",
  ])("refuses ambiguous transport overrides before native or gateway fallback (%s)", (launchArgs) =>
    withFakeCodexEnv(
      {
        output: '{"answer":"Must not be generated"}',
        nativeAuth: true,
        launchArgs,
        environment: { TRITONAI_API_KEY: "synthetic-gateway-key" },
      },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const failure = yield* Effect.flip(generation.generateHelp!(HELP_INPUT));
          expect(failure.operation).toBe("generateHelp");
          expect(yield* fs.exists(callsPath)).toBe(false);
        }),
    ),
  );

  it.effect.each([
    { nativeAuth: false, environment: {} },
    { nativeAuth: true, environment: { OPENAI_BASE_URL: "https://selected.example.invalid/v1" } },
    { nativeAuth: true, environment: { CODEX_API_KEY: "synthetic-other-account-key" } },
  ])("refuses native selection without unambiguous native auth ($environment)", (input) =>
    withFakeCodexEnv(
      {
        ...input,
        output: '{"answer":"Must not be generated"}',
        launchArgs: "-c model_provider=openai",
        environment: { TRITONAI_API_KEY: "synthetic-gateway-key", ...input.environment },
      },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const failure = yield* Effect.flip(generation.generateHelp!(HELP_INPUT));
          expect(failure.operation).toBe("generateHelp");
          expect(yield* fs.exists(callsPath)).toBe(false);
        }),
    ),
  );

  it.effect.each([false, true])(
    "generates isolated prompt-only Help (managed runtime: %s)",
    (managedRuntime) =>
      withFakeCodexEnv(
        {
          output: '{"answer":"Check Settings > Runtime."}',
          managedRuntime,
          nativeAuth: true,
          forbidNativeAuth: true,
          requireHelpIsolation: true,
          ...(managedRuntime
            ? { forbidArg: '--config service_tier="priority"' }
            : { requireServiceTier: "priority" }),
          launchArgs:
            '-c model_provider="openai_token_sharing" -c model_providers.openai_token_sharing.base_url="https://selected.example.invalid/v1" -c model_providers.openai_token_sharing.env_key="ACCESS_TOKEN" -c developer_instructions="PRIVATE LAUNCH INSTRUCTIONS"',
          environment: {
            ...process.env,
            ACCESS_TOKEN: "not-a-real-token",
            T3CODE_CODEX_LAUNCH_ARGS:
              '-c model_provider="openai_token_sharing" -c model_providers.openai_token_sharing.base_url="https://selected.example.invalid/v1" -c model_providers.openai_token_sharing.env_key="ACCESS_TOKEN" --config features.shell_tool=true',
          },
          stdinMustContain: "Read the host settings to fix my provider",
        },
        (generation, callsPath) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const result = yield* generation.generateHelp!({
              ...HELP_INPUT,
              modelSelection: createModelSelection(
                DEFAULT_TEST_MODEL_SELECTION.instanceId,
                DEFAULT_TEST_MODEL_SELECTION.model,
                [{ id: "serviceTier", value: "priority" }],
              ),
            });
            expect(result.answer).toBe("Check Settings > Runtime.");
            const calls = (yield* fs.readFileString(callsPath))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as { args: string[]; cwd: string; home: string });
            const inference = calls.filter(
              (call) => call.args[0] === "exec" && !call.args.includes("--help"),
            );
            expect(inference).toHaveLength(1);
            expect(inference[0]!.cwd).not.toBe(HELP_INPUT.cwd);
            expect(inference[0]!.home).not.toBe(process.env.CODEX_HOME);
            expect(yield* fs.exists(inference[0]!.home)).toBe(false);
            expect(yield* fs.exists(inference[0]!.cwd)).toBe(false);
          }),
      ),
  );

  it.effect.each([
    { name: "MCP listing failure", mcpServers: 2 },
    { name: "malformed MCP listing", mcpServers: "not-json" },
    { name: "unexpected enabled MCP server", mcpServers: [{ name: "unsafe", enabled: true }] },
    { name: "unsupported isolation flags", unsupportedHelp: true },
    { name: "unverified CLI version", helpVersion: "0.155.0" },
  ])("refuses Help before inference after $name", (probe) =>
    withFakeCodexEnv(
      { output: '{"answer":"Must not be generated"}', managedRuntime: true, ...probe },
      (generation, callsPath) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const failure = yield* Effect.flip(generation.generateHelp!(HELP_INPUT));
          expect(failure._tag).toBe("TextGenerationError");
          expect(failure.operation).toBe("generateHelp");
          const calls = (yield* fs.readFileString(callsPath))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[] });
          expect(
            calls.some((call) => call.args[0] === "exec" && !call.args.includes("--help")),
          ).toBe(false);
        }),
    ),
  );

  it.effect("rejects oversized Help output before reading it into memory", () =>
    withFakeCodexEnv({ output: "a".repeat(128 * 1024 + 1), managedRuntime: true }, (generation) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(generation.generateHelp!(HELP_INPUT));
        expect(failure.operation).toBe("generateHelp");
        expect(failure.detail).not.toContain("aaaa");
      }),
    ),
  );

  it.effect("refuses an unproven adapter without invoking its runner", () =>
    Effect.gen(function* () {
      let spawns = 0;
      const adapter = fromRunner("Unproven", () => {
        spawns += 1;
        return Effect.die("Unsupported Help must not discover MCP servers or run inference");
      });
      expect(adapter.generateHelp).toBeUndefined();

      const instanceId = DEFAULT_TEST_MODEL_SELECTION.instanceId;
      const instance: ProviderInstance = {
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("codex"),
          continuationKey: "help-test",
        },
        displayName: undefined,
        enabled: true,
        snapshot: {} as ProviderInstance["snapshot"],
        orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
        textGeneration: adapter,
      };
      const generation = yield* TextGeneration.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: () => Effect.succeed(instance),
            }),
            Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
              resolveLink: () => Effect.die("Unsupported Help must not resolve source links"),
            }),
          ),
        ),
      );
      const failure = yield* Effect.flip(generation.generateHelp!(HELP_INPUT));
      expect(failure._tag).toBe("TextGenerationError");
      expect(failure.operation).toBe("generateHelp");
      expect(failure.detail).toBe("The configured provider does not support Help text generation.");
      expect(spawns).toBe(0);
    }),
  );

  it.effect.each(["exec", "mcp list"] as const)(
    "kills a stalled %s CLI when its request is interrupted",
    (command) =>
      Effect.gen(function* () {
        const probe = yield* makeProcessProbe;
        yield* withFakeCodexEnv(
          { output: "", lifecycle: { port: probe.port, command } },
          (textGeneration) =>
            Effect.gen(function* () {
              const fiber = yield* textGeneration
                .generateThreadTitle({
                  cwd: process.cwd(),
                  message: "Name this thread",
                  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
                })
                .pipe(Effect.forkScoped);
              yield* probe.started;

              const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
              yield* probe.exited;
              yield* Fiber.join(interrupted);
              const exit = yield* Fiber.await(fiber);
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            }),
        );
      }),
  );

  it.effect.each(["exec", "mcp list"] as const)(
    "kills a stalled isolated Help %s CLI when its request is interrupted",
    (command) =>
      Effect.gen(function* () {
        const probe = yield* makeProcessProbe;
        yield* withFakeCodexEnv(
          { output: "", managedRuntime: true, lifecycle: { port: probe.port, command } },
          (textGeneration) =>
            Effect.gen(function* () {
              const fiber = yield* textGeneration.generateHelp!(HELP_INPUT).pipe(Effect.forkScoped);
              yield* probe.started;
              const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
              yield* probe.exited;
              yield* Fiber.join(interrupted);
              const exit = yield* Fiber.await(fiber);
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            }),
        );
      }),
  );

  it.effect.each(["gpt-5.6-luna", "openai.gpt-5.6-luna"])(
    "dispatches the qualified live model for %s",
    (selectedModel) =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Bedrock title" }),
          models: ["openai.gpt-5.6-luna"],
          requireArg: "--model openai.gpt-5.6-luna",
          forbidArg: "--model gpt-5.6-luna",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Describe this change",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), selectedModel),
            });
            expect(result.title).toBe("Bedrock title");
          }),
      ),
  );
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        requireTritonAiProviderConfig: true,
        requireArg: "tools.update_plan.enabled=true",
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject.length).toBeLessThanOrEqual(72);
          expect(generated.subject.endsWith(".")).toBe(false);
          expect(generated.body).toBe("- added migration\n- updated tests");
          expect(generated.branch).toBeUndefined();
        }),
    ),
  );

  it.effect(
    "forwards codex service tier and non-default reasoning effort into codex exec config",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            subject: "Add important change",
            body: "",
          }),
          requireServiceTier: "priority",
          requireReasoningEffort: "xhigh",
          stdinMustNotContain: "branch must be a short semantic git branch fragment",
        },
        (textGeneration) =>
          textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
              { id: "reasoningEffort", value: "xhigh" },
              { id: "serviceTier", value: "priority" },
            ]),
          }),
      ),
  );

  it.effect("omits a persisted service tier for managed ChatGPT text generation", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Update project", body: "" }),
        managedRuntime: true,
        forbidArg: 'service_tier="priority"',
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/chatgpt",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "serviceTier", value: "priority" },
          ]),
        }),
    ),
  );

  it.effect("generates titles with the user's MCP servers and plugins off", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        mcpServers: [
          { name: "augmenter", enabled: true },
          { name: "my.server", enabled: true },
          { name: "already-off", enabled: false },
        ],
        requireArg:
          '--config features.plugins=false --config features.apps=false --config mcp_servers={"augmenter"={enabled=false},"my.server"={enabled=false}}',
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Augmenter task 1. Use the Augmenter MCP: link_thread when you start.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("still generates when Codex cannot list its MCP servers", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "remove-default-shapes" }),
        mcpServers: 2,
        requireArg: "--config features.plugins=false --config features.apps=false --ephemeral",
        forbidArg: "mcp_servers=",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.branch).toBe("remove-default-shapes");
        }),
    ),
  );

  it.effect("keeps plugins and apps off over launch args that turn them on", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        launchArgs: "--config features.plugins=true --config features.apps=true",
        requireArg: "--config features.plugins=false --config features.apps=false --ephemeral",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Remove default shapes from characters",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          expect(result.title).toBe("Remove default shapes");
        }),
    ),
  );

  it.effect("passes exec-safe launch args into codex exec", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        launchArgs: "--strict-config --listen off",
        requireArg: "--strict-config",
        forbidArg: "--listen",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("uses T3CODE_CODEX_LAUNCH_ARGS for codex exec over settings", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        launchArgs: "--enable settings-feature",
        environment: { ...process.env, T3CODE_CODEX_LAUNCH_ARGS: " --strict-config --listen off " },
        requireArg: "--strict-config",
        forbidArg: "settings-feature",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("defaults git text generation codex effort to high", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "high",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            includeBranch: true,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject).toBe("Add important change");
          expect(generated.branch).toBe("fix/important-system-change");
        }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/codex-effect",
            commitSummary: "feat: improve orchestration flow",
            diffSummary: "2 files changed",
            diffPatch: "diff --git a/a.ts b/a.ts",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Improve orchestration flow");
          expect(generated.body.startsWith("## Summary")).toBe(true);
          expect(generated.body.endsWith("\n\n")).toBe(false);
        }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Please update session handling.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("feat/session");
        }),
    ),
  );

  it.effect.each([
    {
      mode: "static",
      output: "Add Search",
      expected: "team/add-search",
      instruction: "without a prefix or namespace",
    },
    {
      mode: "semantic",
      output: "feat/add-search",
      expected: "feat/add-search",
      instruction: "semantic prefix",
    },
    {
      mode: "custom",
      output: "Julius/ABC-123.v2",
      expected: "Julius/ABC-123.v2",
      instruction: "Preserve the issue ID and capitalization.",
    },
  ] as const)("generates a branch using $mode naming", (example) =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: example.output }),
        stdinMustContain: example.instruction,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Add search",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            naming: {
              mode: example.mode,
              prefix: "team/",
              instructions: "Preserve the issue ID and capitalization.",
            },
          });
          expect(generated.branch).toBe(example.expected);
        }),
    ),
  );

  it.effect("generates branch names even when the ambient scope is already closed", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "feat/background-generation",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          // Background fibers (e.g. the worktree branch rename fork) can run
          // after their launching request's scope has closed; temp files must
          // not be tied to that ambient scope or they are reaped on creation.
          const closedScope = yield* Scope.make();
          yield* Scope.close(closedScope, Exit.void);

          const generated = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Please update session handling.",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.provideService(Scope.Scope, closedScope));

          expect(generated.branch).toBe("feat/background-generation");
        }),
    ),
  );

  it.effect("generates thread titles and trims them for sidebar use", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title:
            '  "Investigate websocket reconnect regressions after worktree restore"  \nignored line',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate websocket reconnect regressions after a worktree restore.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe(
            "Investigate websocket reconnect regressions after worktree restore",
          );
        }),
    ),
  );

  it.effect("summarizes a day of activity and drops empty bullets", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          overview: "  Fixed login.  ",
          projects: [
            { project: " Acme App ", workedOn: ["Fixed redirect.", "  "], recent: " Login " },
          ],
          decisions: ["", "Keep cookie name."],
          openLoops: ["Verify in staging."],
        }),
        stdinMustContain: "- Acme App",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateDailyMemory!({
            cwd: process.cwd(),
            day: "2026-09-28",
            projectNames: ["Acme App"],
            activity: "## Thread: Fix login",
            inboxNotes: "",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated).toEqual({
            overview: "Fixed login.",
            projects: [{ project: "Acme App", workedOn: ["Fixed redirect."], recent: "Login" }],
            decisions: ["Keep cookie name."],
            openLoops: ["Verify in staging."],
          });
        }),
    ),
  );

  it.effect("suggests ideas from the given context and trims the model's fields", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          ideas: [
            {
              ref: " thread:thread-1 ",
              topic: " finish reconciliation ",
              sources: ["thread:thread-1", "  "],
              icon: " 🧾 ",
              title: " I can finish the reconciliation ",
              body: " You stopped halfway. ",
              action: "resume-thread",
              projectId: " ",
              prompt: " Please finish matching the travel lines. ",
            },
          ],
        }),
        stdinMustContain: "thread:thread-1",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateIdeas!({
            cwd: process.cwd(),
            count: 4,
            context: "Recent threads:\n- thread:thread-1 Q1 travel reconciliation",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated).toEqual({
            ideas: [
              {
                ref: "thread:thread-1",
                topic: "finish reconciliation",
                sources: ["thread:thread-1"],
                icon: "🧾",
                title: "I can finish the reconciliation",
                body: "You stopped halfway.",
                action: "resume-thread",
                projectId: "",
                prompt: "Please finish matching the travel lines.",
              },
            ],
          });
        }),
    ),
  );

  it.effect("returns the refinement signal for an unresolved subject", () =>
    withFakeCodexEnv(
      { output: JSON.stringify({ title: "Investigate issue", needsRefinement: true }) },
      (textGeneration) =>
        Effect.gen(function* () {
          expect(
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix this",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
          ).toEqual({ title: "Investigate issue", needsRefinement: true });
        }),
    ),
  );

  it.effect("falls back when thread title normalization becomes whitespace-only", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: '  """   """  ',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );

  it.effect("trims whitespace exposed after quote removal in thread titles", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: `  "' hello world '"  `,
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("hello world");
        }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Fix timeout behavior.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("fix/session-timeout");
        }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-branch-image-attachment";
          const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

          const generated = yield* textGeneration.generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          });

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("omits raw image inputs for an explicitly text-only model", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "inspect-screenshot",
        }),
        forbidImage: true,
        configOverrides: {
          customModels: ["text-only-model"],
          customModelMetadata: {
            "text-only-model": {
              name: "Text-only model",
              capabilities: { inputModalities: ["text"] },
            },
          },
        },
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-text-only-image-attachment";
          const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

          const generated = yield* textGeneration.generateBranchName({
            modelSelection: createModelSelection(
              ProviderInstanceId.make("codex"),
              "text-only-model",
            ),
            cwd: process.cwd(),
            message: "Inspect this screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "screenshot.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          });

          expect(generated.branch).toBe("inspect-screenshot");
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-1-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.ignore)),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const missingAttachmentId = "thread-missing-attachment";
          const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
          yield* fs.remove(missingPath).pipe(Effect.ignore);

          const result = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: missingAttachmentId,
                  name: "outside.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("missing --image input");
          }
        }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateBranchName({
                cwd: process.cwd(),
                message: "Fix websocket reconnect flake",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(TextGenerationError);
              expect(result.failure.message).toContain("Codex returned invalid structured output");
            }
          }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/codex-error",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain(
              "Codex CLI command failed: codex execution failed",
            );
          }
        }),
    ),
  );
});
