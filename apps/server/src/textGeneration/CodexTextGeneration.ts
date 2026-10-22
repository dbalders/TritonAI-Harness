import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type CodexSettings,
  type ModelSelection,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  TRITONAI_API_KEY_ENV,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { codexExecLaunchArgs, resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  normalizeCliError,
  toJsonSchemaObject,
} from "@t3tools/provider-core/server/textGenerationUtils";
import {
  codexModelFamily,
  getModelSelectionStringOptionValue,
  modelCapabilitiesAreExplicitlyTextOnly,
} from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildDailyMemoryPrompt,
  buildIdeasPrompt,
} from "@t3tools/provider-core/server/textGenerationPrompts";
import {
  encodeCodexConfigString,
  makeTritonAiCodexConfigArgs,
} from "../provider/Drivers/TritonAiCodexConfig.ts";

const DAILY_MEMORY_TIMEOUT_MS = 600_000;
const IDEAS_TIMEOUT_MS = 300_000;
const CODEX_TIMEOUT_MS = 180_000;
const CODEX_MCP_LIST_TIMEOUT_MS = 10_000;
const CODEX_HELP_INSTRUCTIONS =
  "You answer questions about TritonAI Harness using only the supplied Help prompt. You have no tools.";
// Tool registration can change independently of config flags. Revalidate the
// emitted model request before admitting another CLI version to this boundary.
const CODEX_HELP_VERSIONS = new Set(["0.156.1", "0.161.0", "0.162.0-alpha.17.2"]);
// Plugins and apps bring MCP servers of their own; the user's are listed and
// turned off by name below. These follow the user's launch args, so they win
// over a `-c features.plugins=true` there, which `--disable plugins` does not.
const CODEX_NO_PLUGIN_ARGS = [
  "--config",
  "features.plugins=false",
  "--config",
  "features.apps=false",
] as const;
const CodexMcpServers = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean })),
);
const decodeCodexMcpServers = Schema.decodeEffect(CodexMcpServers);
const decodeCodexModelCatalog = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ models: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
);

/**
 * `mcp_servers={}` merges into the user's servers rather than replacing them,
 * so each is named; quoting the name keeps one with a dot a single key.
 */
const codexMcpServersOff = (names: ReadonlyArray<string>): string | null =>
  names.length === 0
    ? null
    : `mcp_servers={${names.map((name) => `${JSON.stringify(name)}={enabled=false}`).join(",")}}`;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  resolveRuntime?: Effect.Effect<
    import("../provider/CodexManagedRuntime.ts").CodexEffectiveRuntime,
    import("@t3tools/contracts").ProviderSetupError,
    Scope.Scope
  >,
  options?: { readonly modelCatalogPath?: string },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const removeTempFileDir = (filePath: string): Effect.Effect<void, never> =>
    fileSystem
      .remove(path.dirname(filePath), { recursive: true })
      .pipe(Effect.catch(() => Effect.void));

  // Deliberately unscoped: text generation runs from background fibers whose
  // ambient scope may already be closed (a closed scope reaps the temp
  // directory the moment it is created).
  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError> =>
    fileSystem
      .makeTempFile({
        prefix: `t3code-${prefix}-${process.pid}-`,
      })
      .pipe(
        Effect.tap((filePath) =>
          fileSystem
            .writeFileString(filePath, content)
            .pipe(Effect.onError(() => removeTempFileDir(filePath))),
        ),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              cause,
            }),
        ),
      );

  const encodeJsonForOperation = (
    operation: TextGenerationOperations.Operation | "generateDailyMemory" | "generateIdeas",
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    attachments: TextGenerationOperations.Request<Schema.Top>["attachments"],
    modelSelection: ModelSelection,
  ) {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    const modelMetadata = Object.hasOwn(codexConfig.customModelMetadata, modelSelection.model)
      ? codexConfig.customModelMetadata[modelSelection.model]
      : undefined;
    if (modelCapabilitiesAreExplicitlyTextOnly(modelMetadata?.capabilities)) return [];
    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return imagePaths;
  });

  const listEnabledMcpServers = Effect.fn("listEnabledMcpServers")(
    function* (input: {
      readonly binary: string;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly launchArgs: ReadonlyArray<string>;
    }) {
      const spawnCommand = yield* resolveSpawnCommand(
        input.binary,
        [...input.launchArgs, ...CODEX_NO_PLUGIN_ARGS, "mcp", "list", "--json"],
        { env: input.env },
      );
      const child = yield* commandSpawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: input.env,
          cwd: input.cwd,
          shell: spawnCommand.shell,
          forceKillAfter: "1 second",
        }),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        yield* Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
          reason: "exit",
          exitCode,
        });
        return [];
      }
      const servers = yield* decodeCodexMcpServers(stdout).pipe(
        Effect.tapError(() =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "decode",
          }),
        ),
      );
      return servers.filter((server) => server.enabled).map((server) => server.name);
    },
    Effect.scoped,
    Effect.timeoutOption(CODEX_MCP_LIST_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.logWarning("codex mcp list failed; text generation keeps its MCP servers", {
            reason: "timeout",
          }).pipe(Effect.as<ReadonlyArray<string>>([])),
        onSome: (names) => Effect.succeed(names),
      }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  // Help gets a separate launch path: never reuse arbitrary CLI overrides or a
  // user's Codex home. In particular, a read-only sandbox alone is insufficient.
  const runCodexHelpJson: TextGenerationOperations.Runner = (request) =>
    Effect.scoped(
      Effect.gen(function* () {
        const operation = request.operation;
        const fail = () =>
          new TextGenerationError({
            operation,
            detail:
              "Codex could not establish isolated Help generation. Update or reconfigure Codex.",
          });
        const resolved = resolveRuntime
          ? yield* resolveRuntime.pipe(Effect.mapError(() => fail()))
          : undefined;
        const effectiveConfig = resolved?.config ?? codexConfig;
        const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
        const binary = effectiveConfig.binaryPath || "codex";
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tritonai-help-codex-",
        });
        const home = path.join(directory, "home");
        const cwd = path.join(directory, "work");
        yield* fileSystem.makeDirectory(home);
        yield* fileSystem.makeDirectory(cwd);
        const env = { ...effectiveEnvironment, CODEX_HOME: home };
        const readBoundedFile = Effect.fn("CodexTextGeneration.readHelpFile")(function* (
          filePath: string,
          maxBytes: number,
        ) {
          const info = yield* fileSystem.stat(filePath);
          if (info.size > BigInt(maxBytes)) return yield* fail();
          return yield* fileSystem.readFileString(filePath);
        });
        // Retain only the trusted runtime's provider transport settings. Other
        // launch overrides could add instructions, hooks, tools, or extra roots.
        const providerArgs: string[] = [];
        // undefined means absent; null means a selector we cannot safely interpret.
        let selectedProvider: string | null | undefined;
        let hasProviderTransport = false;
        {
          const args = codexExecLaunchArgs(effectiveConfig.launchArgs);
          for (let index = 0; index < args.length; index++) {
            const arg = args[index];
            const value =
              arg === "--config" || arg === "-c"
                ? args[++index]
                : arg?.startsWith("--config=")
                  ? arg.slice("--config=".length)
                  : arg?.startsWith("-c=")
                    ? arg.slice("-c=".length)
                    : undefined;
            if (value === undefined) continue;
            const separator = value.indexOf("=");
            if (separator < 0) return yield* fail();
            const key = value.slice(0, separator).trim();
            const configValue = value.slice(separator + 1).trim();
            if (key === "model_provider") {
              // Codex parses TOML, falling back to a raw string after shell
              // tokenization. Admit only unambiguous provider IDs in either
              // form; escaped/structured selectors fail closed. Later overrides win.
              const selector =
                /^(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z_][A-Za-z0-9_-]*))$/.exec(
                  configValue,
                );
              selectedProvider =
                selector && !(selector[3] && /^(?:true|false|inf|nan)$/.test(selector[3]))
                  ? (selector[1] ?? selector[2] ?? selector[3] ?? null)
                  : null;
              continue;
            }
            // A dotted override replaces a scalar selector with a table. A
            // later root assignment can replace it again, so validate only last.
            if (key.startsWith("model_provider.")) {
              selectedProvider = null;
              continue;
            }
            // Do not silently drop alternate endpoint settings and then reuse
            // native credentials. They are outside Help's transport allowlist.
            if (/^(?:openai_base_url|chatgpt_base_url)(?:\.|$)/.test(key)) return yield* fail();
            const isProviderTransport =
              key === "model_providers" || key.startsWith("model_providers.");
            if (isProviderTransport) hasProviderTransport = true;
            const allowedTransport =
              /^model_providers\.[A-Za-z0-9_-]+\.(?:name|base_url|env_key|wire_api|requires_openai_auth|supports_websockets|model_catalog_url)$/.test(
                key,
              );
            if (isProviderTransport && !allowedTransport) return yield* fail();
            if (allowedTransport) providerArgs.push("--config", `${key}=${configValue}`);
          }
        }
        if (selectedProvider === null) return yield* fail();
        if (selectedProvider === undefined) {
          // Partial transport overrides do not identify which endpoint/account to use.
          // A configured gateway must win over an unrelated native ChatGPT sign-in.
          if (hasProviderTransport) return yield* fail();
          if (effectiveEnvironment[TRITONAI_API_KEY_ENV]?.trim()) {
            providerArgs.push(...makeTritonAiCodexConfigArgs(effectiveEnvironment));
          } else {
            selectedProvider = "openai";
          }
        }
        if (selectedProvider !== undefined)
          providerArgs.push(
            "--config",
            `model_provider=${encodeCodexConfigString(selectedProvider)}`,
          );
        if (selectedProvider === "openai" && !hasProviderTransport) {
          // Native sign-in may be reused only for the built-in transport. A
          // custom provider (even named openai) never receives the native file.
          // Never read/parse tokens or copy config, instructions, skills or history.
          if (
            effectiveEnvironment.OPENAI_BASE_URL?.trim() ||
            effectiveEnvironment.CODEX_API_KEY?.trim()
          )
            return yield* fail();
          const sourceHome =
            !resolved && effectiveConfig.homePath?.trim()
              ? expandHomePath(effectiveConfig.homePath, yield* HostProcess.HomeDirectory)
              : undefined;
          const sourceAuth = sourceHome ? path.join(sourceHome, "auth.json") : undefined;
          if (!sourceAuth || !(yield* fileSystem.exists(sourceAuth))) return yield* fail();
          const targetAuth = path.join(home, "auth.json");
          yield* fileSystem.copyFile(sourceAuth, targetAuth);
          yield* fileSystem.chmod(targetAuth, 0o600);
        }

        const commandOutput = Effect.fn("CodexTextGeneration.helpCommandOutput")(
          function* (args: ReadonlyArray<string>, prompt?: string) {
            const spawn = yield* resolveSpawnCommand(binary, args, { env });
            const child = yield* commandSpawner.spawn(
              ChildProcess.make(spawn.command, spawn.args, {
                env,
                cwd,
                shell: spawn.shell,
                forceKillAfter: "1 second",
                ...(prompt === undefined
                  ? {}
                  : { stdin: { stream: Stream.encodeText(Stream.make(prompt)) } }),
              }),
            );
            const decoder = new TextDecoder();
            const stdout =
              prompt === undefined
                ? child.stdout.pipe(
                    Stream.runFoldEffect(
                      () => ({ bytes: 0, text: "" }),
                      (state, chunk) => {
                        const bytes = state.bytes + chunk.byteLength;
                        return bytes > 16 * 1024 * 1024
                          ? Effect.fail(fail())
                          : Effect.succeed({
                              bytes,
                              text: state.text + decoder.decode(chunk, { stream: true }),
                            });
                      },
                    ),
                    Effect.map((state) => state.text + decoder.decode()),
                  )
                : child.stdout.pipe(Stream.runDrain, Effect.as(""));
            const [output, , code] = yield* Effect.all(
              [stdout, child.stderr.pipe(Stream.runDrain), child.exitCode],
              { concurrency: "unbounded" },
            );
            if (code !== 0) return yield* fail();
            return output;
          },
          (effect, _args, prompt?: string) =>
            effect.pipe(
              Effect.timeoutOption(
                prompt === undefined ? CODEX_MCP_LIST_TIMEOUT_MS : CODEX_TIMEOUT_MS,
              ),
              Effect.flatMap(
                Option.match({ onNone: () => Effect.fail(fail()), onSome: Effect.succeed }),
              ),
            ),
        );

        const version = (yield* commandOutput(["--version"])).trim().replace(/^codex-cli\s+/, "");
        if (!CODEX_HELP_VERSIONS.has(version)) return yield* fail();
        const help = yield* commandOutput(["exec", "--help"]);
        if (
          !["--ignore-user-config", "--ignore-rules", "--strict-config", "--output-schema"].every(
            (flag) => help.includes(flag),
          )
        )
          return yield* fail();
        const features = yield* commandOutput(["features", "list"]);
        const featureNames = features
          .trim()
          .split(/\r?\n/)
          .map((line) => {
            const match = /^([a-z][a-z0-9_.]*)\s+(.+?)\s+(?:true|false)\s*$/.exec(line);
            return match && match[2] !== "removed" ? match[1] : undefined;
          })
          .filter((name): name is string => name !== undefined);
        if (
          !["shell_tool", "view_image", "skip_host_skill_discovery", "plugins", "apps"].every(
            (name) => featureNames.includes(name),
          )
        )
          return yield* fail();
        const featureArgs = featureNames.flatMap((name) => [
          "--config",
          `features.${name}=${name === "skip_host_skill_discovery" ? "true" : "false"}`,
        ]);
        const models = yield* getModels;
        const requestedModel = request.modelSelection.model;
        const model =
          models.find((candidate) => candidate.slug === requestedModel)?.slug ??
          models.find(
            (candidate) =>
              !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
          )?.slug ??
          requestedModel;
        const serviceTier = resolved
          ? undefined
          : getCodexServiceTierOptionValue(request.modelSelection);
        const catalogJson = options?.modelCatalogPath
          ? yield* readBoundedFile(options.modelCatalogPath, 16 * 1024 * 1024)
          : yield* commandOutput(["debug", "models", "--bundled"]);
        const parsed = yield* decodeCodexModelCatalog(catalogJson);
        const template = parsed.models.find((entry) => entry.slug === model) ?? parsed.models[0];
        if (!template) return yield* fail();
        const catalog = yield* encodeJsonForOperation(operation, {
          models: [
            {
              ...template,
              slug: model,
              display_name: model,
              base_instructions: CODEX_HELP_INSTRUCTIONS,
              model_messages: null,
              shell_type: "disabled",
              apply_patch_tool_type: null,
              experimental_supported_tools: [],
              supports_search_tool: false,
              input_modalities: ["text"],
              include_skills_usage_instructions: false,
              include_plugin_usage_instructions: false,
              include_apps_usage_instructions: false,
              supports_parallel_tool_calls: false,
              use_responses_lite: false,
              tool_mode: null,
              multi_agent_version: null,
              auto_review_model_override: null,
            },
          ],
        });
        const catalogPath = path.join(directory, "models.json");
        const schemaPath = path.join(directory, "schema.json");
        const outputPath = path.join(directory, "answer.json");
        yield* fileSystem.writeFileString(catalogPath, catalog);
        yield* fileSystem.writeFileString(
          schemaPath,
          yield* encodeJsonForOperation(operation, toJsonSchemaObject(request.outputSchema)),
        );
        const safetyArgs = [
          ...featureArgs,
          "--config",
          'web_search="disabled"',
          "--config",
          "tools.update_plan.enabled=false",
          "--config",
          "tools.experimental_request_user_input.enabled=false",
          "--config",
          "project_doc_max_bytes=0",
          "--config",
          'developer_instructions=""',
          "--config",
          "skills.include_instructions=false",
          "--config",
          "skills.bundled.enabled=false",
          "--config",
          "include_environment_context=false",
          "--config",
          "include_permissions_instructions=false",
          "--config",
          "include_apps_instructions=false",
          "--config",
          "include_collaboration_mode_instructions=false",
          "--config",
          "orchestrator.skills.enabled=false",
          "--config",
          "orchestrator.mcp.enabled=false",
          "--config",
          "memories.use_memories=false",
          "--config",
          "memories.generate_memories=false",
          "--config",
          `model_catalog_json=${encodeCodexConfigString(catalogPath)}`,
        ];
        // A fresh home contains no configured servers. Still verify this and
        // refuse every discovery failure; Help never uses the ordinary fail-open path.
        const listed = yield* decodeCodexMcpServers(
          yield* commandOutput([...providerArgs, ...safetyArgs, "mcp", "list", "--json"]),
        );
        if (listed.some((server) => server.enabled)) return yield* fail();
        yield* commandOutput(
          [
            "exec",
            ...providerArgs,
            ...safetyArgs,
            "--ignore-user-config",
            "--ignore-rules",
            "--strict-config",
            "--ephemeral",
            "--skip-git-repo-check",
            "--config",
            'approval_policy="never"',
            "--config",
            'default_permissions="help"',
            "--config",
            `permissions.help.filesystem={":minimal"="read",${encodeCodexConfigString(cwd)}="read"}`,
            "--config",
            "permissions.help.network.enabled=false",
            "--model",
            model,
            "--config",
            `model_reasoning_effort=${encodeCodexConfigString(getModelSelectionStringOptionValue(request.modelSelection, "reasoningEffort") ?? DEFAULT_TEXT_GENERATION_REASONING_EFFORT)}`,
            ...(serviceTier
              ? ["--config", `service_tier=${encodeCodexConfigString(serviceTier)}`]
              : []),
            "--output-schema",
            schemaPath,
            "--output-last-message",
            outputPath,
            "-",
          ],
          request.prompt,
        );
        return yield* TextGenerationOperations.decodeJsonReply(
          request,
          "Codex",
          yield* readBoundedFile(outputPath, 128 * 1024),
        );
      }),
    ).pipe(
      Effect.catch(() =>
        Effect.fail(
          new TextGenerationError({
            operation: request.operation,
            detail:
              "Codex could not establish isolated Help generation. Update or reconfigure Codex.",
          }),
        ),
      ),
    );

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema: outputSchemaJson,
    modelSelection,
    attachments,
    investigate,
  }: Omit<TextGenerationOperations.Request<S>, "operation"> & {
    readonly operation:
      | TextGenerationOperations.Operation
      | "generateDailyMemory"
      | "generateIdeas";
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const imagePaths = yield* materializeImageAttachments(attachments, modelSelection);
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "").pipe(
      Effect.onError(() => removeTempFileDir(schemaPath)),
    );

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const resolved = resolveRuntime
        ? yield* resolveRuntime.pipe(
            Effect.mapError(
              (cause) => new TextGenerationError({ operation, detail: cause.detail }),
            ),
          )
        : undefined;
      const effectiveConfig = resolved?.config ?? codexConfig;
      const effectiveEnvironment = resolved?.environment ?? resolvedEnvironment;
      const models = yield* getModels;
      const requestedModel = modelSelection.model;
      const model =
        models.find((candidate) => candidate.slug === requestedModel)?.slug ??
        models.find(
          (candidate) => !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
        )?.slug ??
        requestedModel;
      const launchArgs = resolveCodexLaunchArgs(effectiveConfig.launchArgs, effectiveEnvironment);
      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier = resolved ? undefined : getCodexServiceTierOptionValue(modelSelection);
      const binary = effectiveConfig.binaryPath || "codex";
      const env = {
        ...effectiveEnvironment,
        ...(effectiveConfig.homePath
          ? {
              CODEX_HOME: expandHomePath(
                effectiveConfig.homePath,
                yield* HostProcess.HomeDirectory,
              ),
            }
          : {}),
      };
      const execLaunchArgs = codexExecLaunchArgs(launchArgs);
      const mcpServersOff = yield* listEnabledMcpServers({
        binary,
        cwd,
        env,
        // `codex mcp` rejects --strict-config; the overrides still apply.
        launchArgs: execLaunchArgs.filter((arg) => arg !== "--strict-config"),
      }).pipe(Effect.map(codexMcpServersOff));
      const spawnCommand = yield* resolveSpawnCommand(
        binary,
        [
          "exec",
          ...execLaunchArgs,
          ...makeTritonAiCodexConfigArgs(effectiveEnvironment),
          ...(options?.modelCatalogPath
            ? [
                "--config",
                `model_catalog_json=${encodeCodexConfigString(options.modelCatalogPath)}`,
              ]
            : []),
          // Text generation needs only the prompt. A user's MCP server would
          // otherwise start and could act on it, as Claude's --strict-mcp-config
          // prevents for Claude.
          ...CODEX_NO_PLUGIN_ARGS,
          ...(mcpServersOff ? ["--config", mcpServersOff] : []),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: effectiveEnvironment },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        cwd,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
        forceKillAfter: "1 second",
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    const cleanup = Effect.all([removeTempFileDir(schemaPath), removeTempFileDir(outputPath)], {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.scoped,
        // The read-only sandbox already holds an investigation to reading; it only needs longer.
        Effect.timeoutOption(
          investigate?.timeoutMs ??
            (operation === "generateDailyMemory"
              ? DAILY_MEMORY_TIMEOUT_MS
              : operation === "generateIdeas"
                ? IDEAS_TIMEOUT_MS
                : CODEX_TIMEOUT_MS),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  const generateDailyMemory = Effect.fn("CodexTextGeneration.generateDailyMemory")(function* (
    input: TextGeneration.DailyMemoryGenerationInput,
  ) {
    const { prompt, outputSchema } = buildDailyMemoryPrompt({
      day: input.day,
      projectNames: input.projectNames,
      activity: input.activity,
      inboxNotes: input.inboxNotes,
    });

    const generated = yield* runCodexJson({
      operation: "generateDailyMemory",
      cwd: input.cwd,
      prompt,
      outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      overview: generated.overview.trim(),
      projects: generated.projects.map((entry) => ({
        project: entry.project.trim(),
        workedOn: entry.workedOn.map((line) => line.trim()).filter((line) => line.length > 0),
        recent: entry.recent.trim(),
      })),
      decisions: generated.decisions.map((line) => line.trim()).filter((line) => line.length > 0),
      openLoops: generated.openLoops.map((line) => line.trim()).filter((line) => line.length > 0),
    } satisfies TextGeneration.DailyMemoryGenerationResult;
  });

  const generateIdeas = Effect.fn("CodexTextGeneration.generateIdeas")(function* (
    input: TextGeneration.IdeasGenerationInput,
  ) {
    const { prompt, outputSchema } = buildIdeasPrompt({
      count: input.count,
      context: input.context,
      ...(input.project ? { project: input.project } : {}),
    });

    const generated = yield* runCodexJson({
      operation: "generateIdeas",
      cwd: input.cwd,
      prompt,
      outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      ...("description" in generated && typeof generated.description === "string"
        ? { description: generated.description.trim() }
        : {}),
      ideas: generated.ideas.map((idea) => ({
        ref: idea.ref.trim(),
        topic: idea.topic.trim(),
        sources: idea.sources.map((source) => source.trim()).filter((source) => source.length > 0),
        icon: idea.icon.trim(),
        title: idea.title.trim(),
        body: idea.body.trim(),
        action: idea.action,
        projectId: idea.projectId.trim(),
        prompt: idea.prompt.trim(),
      })),
    } satisfies TextGeneration.IdeasGenerationResult;
  });

  return {
    ...TextGenerationOperations.fromRunner(
      "CodexTextGeneration",
      (request) =>
        request.operation === "generateHelp" ? runCodexHelpJson(request) : runCodexJson(request),
      { help: { promptOnly: true } },
    ),
    generateDailyMemory,
    generateIdeas,
  };
});
