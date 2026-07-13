import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Types from "effect/Types";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";

import type {
  CodexSettings,
  ServerProvider,
  ServerProviderState,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderModel,
  ServerProviderSkill,
} from "@t3tools/contracts";
import {
  DEFAULT_TRITONAI_CODEX_MODEL,
  DEFAULT_TRITONAI_CODEX_MODEL_DISPLAY_NAME,
  ServerSettingsError,
  TRITONAI_APP_BASE_NAME,
} from "@t3tools/contracts";

import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import * as Integrations from "../../integrations/IntegrationRegistry.ts";
import { makeTritonAiCodexConfigArgs } from "../Drivers/TritonAiCodexConfig.ts";
import packageJson from "../../../package.json" with { type: "json" };
const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);

const CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER = "2 seconds" as const;

const CODEX_PRESENTATION = {
  displayName: "TritonAI",
  showInteractionModeToggle: true,
} as const;

function codexModelDisplayName(slug: string): string {
  if (slug === DEFAULT_TRITONAI_CODEX_MODEL) return DEFAULT_TRITONAI_CODEX_MODEL_DISPLAY_NAME;
  return slug;
}

type CustomModelMetadata = CodexSettings["customModelMetadata"];

function metadataForModel(
  customModelMetadata: CustomModelMetadata,
  slug: string,
): CustomModelMetadata[string] | undefined {
  return Object.hasOwn(customModelMetadata, slug) ? customModelMetadata[slug] : undefined;
}

export function curateVisibleCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  configuredModels: ReadonlyArray<string>,
  customModelMetadata: CustomModelMetadata = {},
): ReadonlyArray<ServerProviderModel> {
  const configuredModelSlugs = Array.from(
    new Set(configuredModels.map((model) => model.trim()).filter(Boolean)),
  );
  // Managed installs supply the key-scoped model list; this is only the unmanaged fallback.
  const visibleModelSlugs =
    configuredModelSlugs.length > 0 ? configuredModelSlugs : [DEFAULT_TRITONAI_CODEX_MODEL];
  const visibleModelSlugSet = new Set(visibleModelSlugs);

  return appendCustomCodexModels(models, visibleModelSlugs, customModelMetadata)
    .filter((model) => visibleModelSlugSet.has(model.slug))
    .map((model) => {
      const defaultModel =
        model.slug === DEFAULT_TRITONAI_CODEX_MODEL
          ? {
              ...model,
              name: DEFAULT_TRITONAI_CODEX_MODEL_DISPLAY_NAME,
              shortName: "DeepSeek",
              isCustom: false,
              capabilities: tritonAiCodexCapabilities(model.capabilities),
            }
          : model;
      const metadata = metadataForModel(customModelMetadata, model.slug);
      if (!metadata) return defaultModel;
      return {
        ...defaultModel,
        name: metadata.name,
        ...(metadata.shortName ? { shortName: metadata.shortName } : {}),
        ...(metadata.capabilities !== undefined ? { capabilities: metadata.capabilities } : {}),
      };
    });
}

export interface CodexAppServerProviderSnapshot {
  readonly account: CodexSchema.V2GetAccountResponse;
  readonly version: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

const DEFAULT_SERVICE_TIER_ID = "default";
const DEFAULT_TRITONAI_REASONING_EFFORT = "medium";
const TRITONAI_REASONING_EFFORT_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: DEFAULT_TRITONAI_REASONING_EFFORT, label: "Medium", isDefault: true },
  { id: "high", label: "High" },
] as const;

function reasoningEffortLabel(reasoningEffort: string): string {
  return REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort;
}

function makeTritonAiReasoningEffortDescriptor(): ProviderOptionDescriptor {
  return {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: TRITONAI_REASONING_EFFORT_OPTIONS.map((option) => ({ ...option })),
    currentValue: DEFAULT_TRITONAI_REASONING_EFFORT,
  };
}

function makeTritonAiCodexFallbackCapabilities(): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [makeTritonAiReasoningEffortDescriptor()],
  });
}

function hasOptionDescriptors(capabilities: ModelCapabilities | null | undefined): boolean {
  return (capabilities?.optionDescriptors?.length ?? 0) > 0;
}

function hasReasoningEffortDescriptor(capabilities: ModelCapabilities | null | undefined): boolean {
  return (
    capabilities?.optionDescriptors?.some((descriptor) => descriptor.id === "reasoningEffort") ??
    false
  );
}

export function tritonAiCodexCapabilities(
  capabilities: ModelCapabilities | null | undefined,
): ModelCapabilities {
  if (capabilities && hasReasoningEffortDescriptor(capabilities)) {
    return capabilities;
  }
  if (capabilities && hasOptionDescriptors(capabilities)) {
    return createModelCapabilities({
      optionDescriptors: [
        makeTritonAiReasoningEffortDescriptor(),
        ...(capabilities.optionDescriptors ?? []),
      ],
    });
  }
  return makeTritonAiCodexFallbackCapabilities();
}

function codexAccountAuthLabel(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type !== "chatgpt") return undefined;

  switch (account.planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 20x Subscription";
    case "prolite":
      return "ChatGPT Pro 5x Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      account.planType satisfies never;
      return undefined;
  }
}

function codexAccountEmail(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account || account.type !== "chatgpt") return undefined;
  return account.email;
}

export function mapCodexModelCapabilities(
  model: CodexSchema.V2ModelListResponse__Model,
): ModelCapabilities {
  const reasoningOptions = model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
    reasoningEffort === model.defaultReasoningEffort
      ? {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
          isDefault: true,
        }
      : {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
        },
  );
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const serviceTiers =
    model.serviceTiers && model.serviceTiers.length > 0
      ? model.serviceTiers
      : (model.additionalSpeedTiers ?? []).map((id) => ({
          id,
          name: id === "fast" ? "Fast" : id,
          description: "",
        }));
  const catalogDefaultServiceTier = serviceTiers.some(
    (tier) => tier.id === model.defaultServiceTier,
  )
    ? model.defaultServiceTier
    : null;
  const defaultServiceTier = catalogDefaultServiceTier ?? DEFAULT_SERVICE_TIER_ID;
  const optionDescriptors: ProviderOptionDescriptor[] = [];

  if (reasoningOptions.length > 0) {
    optionDescriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: reasoningOptions,
      ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
    });
  }
  if (serviceTiers.length > 0) {
    optionDescriptors.push({
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        {
          id: DEFAULT_SERVICE_TIER_ID,
          label: "Standard",
          ...(defaultServiceTier === DEFAULT_SERVICE_TIER_ID ? { isDefault: true } : {}),
        },
        ...serviceTiers.map((tier) => ({
          id: tier.id,
          label: tier.name,
          ...(tier.description ? { description: tier.description } : {}),
          ...(defaultServiceTier === tier.id ? { isDefault: true } : {}),
        })),
      ],
      currentValue: defaultServiceTier,
    });
  }

  return createModelCapabilities({
    optionDescriptors,
  });
}

const toDisplayName = (model: CodexSchema.V2ModelListResponse__Model): string => {
  // Capitalize 'gpt' to 'GPT-' and capitalize any letter following a dash
  return model.displayName
    .replace(/^gpt/i, "GPT") // Handle start with 'gpt' or 'GPT'
    .replace(/-([a-z])/g, (_, c) => "-" + c.toUpperCase());
};

function parseCodexModelListResponse(
  response: CodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> {
  return response.data.map((model) => ({
    slug: model.model,
    name: toDisplayName(model),
    isCustom: false,
    capabilities: mapCodexModelCapabilities(model),
  }));
}

function appendCustomCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
  customModelMetadata: CustomModelMetadata,
): ReadonlyArray<ServerProviderModel> {
  if (customModels.length === 0) {
    return models;
  }

  const seen = new Set(models.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];
  for (const rawModel of customModels) {
    const slug = rawModel.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const metadata = metadataForModel(customModelMetadata, slug);
    customEntries.push({
      slug,
      name: metadata?.name ?? codexModelDisplayName(slug),
      ...(metadata?.shortName ? { shortName: metadata.shortName } : {}),
      isCustom: true,
      capabilities: metadata?.capabilities ?? null,
    });
  }
  return customEntries.length === 0 ? models : [...models, ...customEntries];
}

function parseCodexSkillsListResponse(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return dedupeServerProviderSkills(
    skills.map((skill) => {
      const shortDescription =
        skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

      const parsedSkill: Types.Mutable<ServerProviderSkill> = {
        name: skill.name,
        path: skill.path,
        enabled: skill.enabled,
      };

      if (skill.description) {
        parsedSkill.description = skill.description;
      }
      if (skill.scope) {
        parsedSkill.scope = skill.scope;
      }
      if (skill.interface?.displayName) {
        parsedSkill.displayName = skill.interface.displayName;
      }
      if (shortDescription) {
        parsedSkill.shortDescription = shortDescription;
      }

      return parsedSkill;
    }),
  );
}

export function stabilizeIntegrationSkillPaths(
  skills: ReadonlyArray<ServerProviderSkill>,
  temporarySkills: ReadonlyArray<Integrations.IntegrationRuntimeSkill>,
  stableSkills: ReadonlyArray<Integrations.IntegrationRuntimeSkill>,
): ReadonlyArray<ServerProviderSkill> {
  const temporaryPathByName = new Map(
    temporarySkills.map((skill) => [skill.name, skill.path] as const),
  );
  const stablePathByName = new Map(stableSkills.map((skill) => [skill.name, skill.path] as const));
  return skills.map((skill) => {
    const temporaryPath = temporaryPathByName.get(skill.name);
    const stablePath = stablePathByName.get(skill.name);
    return temporaryPath && stablePath && skill.path === temporaryPath
      ? { ...skill, path: stablePath }
      : skill;
  });
}

function dedupeServerProviderSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  const skillByName = new Map<string, ServerProviderSkill>();
  for (const skill of skills) {
    const existing = skillByName.get(skill.name);
    if (!existing || (!existing.enabled && skill.enabled)) {
      skillByName.set(skill.name, skill);
    }
  }
  return [...skillByName.values()];
}

const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: "tritonai_harness_desktop",
      title: `${TRITONAI_APP_BASE_NAME} Desktop`,
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

const probeCodexAppServerProvider = Effect.fn("probeCodexAppServerProvider")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly customModels?: ReadonlyArray<string>;
  readonly customModelMetadata?: CustomModelMetadata;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  // `~` is not shell-expanded when env vars are set via `child_process.spawn`,
  // so `CODEX_HOME=~/.codex_work` would reach codex verbatim and trip
  // "CODEX_HOME points to '~/.codex_work', but that path does not exist".
  // Expand here for parity with `CodexTextGeneration`/`CodexSessionRuntime`.
  const resolvedHomePath = input.homePath ? expandHomePath(input.homePath) : undefined;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = {
    ...input.environment,
    ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
  };
  const spawnCommand = yield* resolveSpawnCommand(
    input.binaryPath,
    ["app-server", ...makeTritonAiCodexConfigArgs(environment)],
    {
      env: environment,
      extendEnv: true,
    },
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        env: environment,
        extendEnv: true,
        forceKillAfter: CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${input.binaryPath} app-server`,
            cause,
          }),
      ),
    );
  const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  const initialize = yield* client.request("initialize", {
    clientInfo: {
      name: "tritonai_harness_desktop",
      title: `${TRITONAI_APP_BASE_NAME} Desktop`,
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  yield* client.notify("initialized", undefined);

  // Extract the version string after the first '/' in userAgent, up to the next space or the end
  const versionMatch = initialize.userAgent.match(/\/([^\s]+)/);
  const version = versionMatch ? versionMatch[1] : undefined;

  const accountResponse = yield* client.request("account/read", {});
  if (!accountResponse.account && accountResponse.requiresOpenaiAuth) {
    return {
      account: accountResponse,
      version,
      models: curateVisibleCodexModels(
        [],
        input.customModels ?? [],
        input.customModelMetadata ?? {},
      ),
      skills: [],
    } satisfies CodexAppServerProviderSnapshot;
  }

  const integrationRegistry = Integrations.getIntegrationRegistryOptional();
  const integrationSkillRuntime = integrationRegistry
    ? yield* Effect.tryPromise(() => integrationRegistry.prepareSkillRuntime()).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to prepare integration plugin skills for provider status.", {
            cause,
          }).pipe(Effect.as(null)),
        ),
      )
    : null;
  const releaseIntegrationSkills =
    integrationRegistry && integrationSkillRuntime
      ? Effect.tryPromise(() =>
          integrationRegistry.releaseSkillRuntime(integrationSkillRuntime.root),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to release provider-status integration skills.", { cause }),
          ),
        )
      : Effect.void;
  const [skillsResponse, models] = yield* Effect.gen(function* () {
    if (integrationSkillRuntime) {
      yield* client.request("skills/extraRoots/set", {
        extraRoots: integrationSkillRuntime.skills.map((skill) => skill.root),
      });
    }
    return yield* Effect.all(
      [
        client.request("skills/list", {
          cwds: [input.cwd],
          forceReload: integrationSkillRuntime !== null,
        }),
        requestAllCodexModels(client),
      ],
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.ensuring(releaseIntegrationSkills));

  const listedSkills = parseCodexSkillsListResponse(skillsResponse, input.cwd);
  const skills =
    integrationRegistry && integrationSkillRuntime
      ? stabilizeIntegrationSkillPaths(
          listedSkills,
          integrationSkillRuntime.skills,
          integrationRegistry.getAvailableSkillsSync(),
        )
      : listedSkills;

  return {
    account: accountResponse,
    version,
    models: curateVisibleCodexModels(
      models,
      input.customModels ?? [],
      input.customModelMetadata ?? {},
    ),
    skills,
  } satisfies CodexAppServerProviderSnapshot;
});

const emptyCodexModelsFromSettings = (codexSettings: CodexSettings): ServerProvider["models"] => {
  return curateVisibleCodexModels(
    [],
    codexSettings.customModels,
    codexSettings.customModelMetadata,
  );
};

const makePendingCodexProvider = (
  codexSettings: CodexSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = emptyCodexModelsFromSettings(codexSettings);

    if (!codexSettings.enabled) {
      return buildServerProvider({
        presentation: CODEX_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        skills: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "The TritonAI Codex runtime is disabled in TritonAI Harness settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex provider status has not been checked in this session yet.",
      },
    });
  });

function accountProbeStatus(account: CodexAppServerProviderSnapshot["account"]): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const authLabel = codexAccountAuthLabel(account.account);
  const authEmail = codexAccountEmail(account.account);
  const auth = {
    status: account.account ? ("authenticated" as const) : ("unknown" as const),
    ...(account.account?.type ? { type: account.account?.type } : {}),
    ...(authLabel ? { label: authLabel } : {}),
    ...(authEmail ? { email: authEmail } : {}),
  } satisfies ServerProvider["auth"];

  if (account.account) {
    return { status: "ready", auth };
  }

  if (account.requiresOpenaiAuth) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  return { status: "ready", auth };
}

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  codexSettings: CodexSettings,
  probe: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly cwd: string;
    readonly customModels: ReadonlyArray<string>;
    readonly customModelMetadata: CustomModelMetadata;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<
    CodexAppServerProviderSnapshot,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  > = probeCodexAppServerProvider,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const emptyModels = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "The TritonAI Codex runtime is disabled in TritonAI Harness settings.",
      },
    });
  }

  const probeResult = yield* probe({
    binaryPath: codexSettings.binaryPath,
    homePath: codexSettings.homePath,
    cwd: process.cwd(),
    customModels: codexSettings.customModels,
    customModelMetadata: codexSettings.customModelMetadata,
    environment: resolvedEnvironment,
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS)),
    Effect.result,
  );

  if (Result.isFailure(probeResult)) {
    const error = probeResult.failure;
    const installed = !isCodexAppServerSpawnError(error);
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: installed
          ? `Codex app-server provider probe failed: ${error.message}.`
          : "Codex CLI (`codex`) is not installed or not on PATH.",
      },
    });
  }

  if (Option.isNone(probeResult.success)) {
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Timed out while checking Codex app-server provider status.",
      },
    });
  }

  const snapshot = probeResult.success.value;
  const accountStatus = accountProbeStatus(snapshot.account);

  return buildServerProvider({
    presentation: CODEX_PRESENTATION,
    enabled: codexSettings.enabled,
    checkedAt,
    models: snapshot.models,
    skills: dedupeServerProviderSkills(snapshot.skills),
    probe: {
      installed: true,
      version: snapshot.version ?? null,
      status: accountStatus.status,
      auth: accountStatus.auth,
      ...(accountStatus.message ? { message: accountStatus.message } : {}),
    },
  });
});

// NOTE: the singleton `CodexProviderLive` Layer has been removed as part of
// the per-instance-driver refactor. `CodexDriver.create()` builds a managed
// snapshot per instance (each with its own `CodexSettings`) and hands the
// resulting `ServerProviderShape` back as `ProviderInstance.snapshot`.
//
// The `makePendingCodexProvider` and `checkCodexProviderStatus` helpers are
// re-exported for use by `CodexDriver`.
export { makePendingCodexProvider };
