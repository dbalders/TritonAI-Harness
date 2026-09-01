import {
  IntegrationConnectResult,
  IntegrationProviderPollResult,
  type IntegrationConnectionSubmission,
} from "@t3tools/contracts";
import {
  type JsonObject,
  type JsonSchema as PluginJsonSchema,
  type JsonValue,
  validateJsonValue,
} from "@t3tools/shared/pluginSdkContract";
import {
  type PluginSdkArtifactFile,
  type VerifiedPluginSdkArtifact,
  verifyPluginSdkArtifact,
} from "@t3tools/shared/pluginSdkArtifact";
import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

import type * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  IntegrationProviderPublicError,
  type IntegrationInvocationContext,
  type IntegrationLifecycleContext,
  type IntegrationPackage,
  type IntegrationProvider,
  type IntegrationProviderStatus,
} from "../IntegrationRegistry.ts";
import { scopeIntegrationSecretStore } from "../IntegrationSecretStore.ts";
import type { IntegrationProviderTool } from "../IntegrationTool.ts";

interface PluginSdkOperationContext {
  readonly signal: AbortSignal;
}

interface PluginSdkLifecycleContext extends PluginSdkOperationContext {
  beginCommit(): Promise<AbortSignal>;
}

interface PluginSdkInvocationContext extends PluginSdkOperationContext {
  readonly writeApproved: boolean;
  beginCommit(): Promise<AbortSignal>;
}

interface PluginSdkSecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

interface PluginSdkProvider {
  readonly id: string;
  status(context: PluginSdkOperationContext): Promise<IntegrationProviderStatus>;
  prepare?(context: PluginSdkLifecycleContext): Promise<void>;
  connect?(
    capabilities: ReadonlyArray<string>,
    context: PluginSdkLifecycleContext,
    submission?: IntegrationConnectionSubmission,
  ): Promise<IntegrationConnectResult>;
  poll?(flowId: string, context: PluginSdkLifecycleContext): Promise<IntegrationProviderPollResult>;
  disconnect?(context: PluginSdkLifecycleContext): Promise<void>;
  invoke(
    toolName: string,
    input: JsonObject,
    context: PluginSdkInvocationContext,
  ): Promise<JsonValue>;
  close?(): Promise<void>;
}

interface PluginSdkModule {
  readonly createIntegrationProvider?: (input: {
    readonly secrets: PluginSdkSecretStore;
    readonly configuration: JsonObject;
  }) => PluginSdkProvider;
}

const DEFAULT_ADMISSION_TIMEOUT_MS = 5_000;

export class PluginSdkQuarantineError extends Error {
  constructor(cause?: unknown) {
    super("A plugin SDK provider was quarantined.", cause === undefined ? undefined : { cause });
    this.name = "PluginSdkQuarantineError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    Boolean(value) &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

function compileJsonSchema(schema: PluginJsonSchema): Schema.Decoder<unknown> {
  return SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft2020_12(schema as JsonSchema.JsonSchema),
  ) as Schema.Decoder<unknown>;
}

const decodeConnectResult = Schema.decodeUnknownPromise(IntegrationConnectResult);
const decodePollResult = Schema.decodeUnknownPromise(IntegrationProviderPollResult);

function validateStatusResult(value: unknown): IntegrationProviderStatus {
  const status = validateJsonValue(value, "Plugin SDK status");
  if (!isRecord(status) || Object.keys(status).length !== 4) {
    throw new Error("Plugin SDK status is invalid.");
  }
  const accountLabel =
    typeof status.accountLabel === "string" ? status.accountLabel.trim() : status.accountLabel;
  const message = typeof status.message === "string" ? status.message.trim() : status.message;
  if (
    typeof status.state !== "string" ||
    !["not_connected", "connecting", "connected", "error"].includes(status.state) ||
    (accountLabel !== null && (typeof accountLabel !== "string" || accountLabel.length === 0)) ||
    !Array.isArray(status.grantedCapabilities) ||
    status.grantedCapabilities.some(
      (capability) => typeof capability !== "string" || capability.trim().length === 0,
    ) ||
    (message !== null && (typeof message !== "string" || message.length === 0))
  ) {
    throw new Error("Plugin SDK status is invalid.");
  }
  return {
    state: status.state as IntegrationProviderStatus["state"],
    accountLabel: accountLabel as string | null,
    grantedCapabilities: [
      ...new Set(status.grantedCapabilities.map((capability) => capability.trim())),
    ],
    message: message as string | null,
  };
}

function validateVoidResult(value: unknown): void {
  if (value !== undefined) throw new Error("Plugin SDK lifecycle result must be undefined.");
}

const validateConnectResult = (value: unknown): Promise<IntegrationConnectResult> =>
  decodeConnectResult(validateJsonValue(value, "Plugin SDK connect result"), {
    onExcessProperty: "error",
  });

const validatePollResult = (value: unknown): Promise<IntegrationProviderPollResult> =>
  decodePollResult(validateJsonValue(value, "Plugin SDK poll result"), {
    onExcessProperty: "error",
  });

function secretStore(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  pluginId: string,
): PluginSdkSecretStore {
  const scoped = scopeIntegrationSecretStore(secrets, pluginId);
  return {
    get: async (name) =>
      Option.match(await Effect.runPromise(scoped.get(name)), {
        onNone: () => null,
        onSome: (value) => new TextDecoder("utf-8", { fatal: true }).decode(value),
      }),
    set: (name, value) => Effect.runPromise(scoped.set(name, new TextEncoder().encode(value))),
    remove: (name) => Effect.runPromise(scoped.remove(name)),
  };
}

function beginCommit(
  context: IntegrationInvocationContext | undefined,
): () => Promise<AbortSignal> {
  return () =>
    context?.beginCommit
      ? context.beginCommit()
      : Promise.reject(new Error("The host did not admit an external commit."));
}

function lifecycleContext(
  context: IntegrationLifecycleContext | undefined,
): PluginSdkLifecycleContext {
  const controller = new AbortController();
  return {
    signal: context?.signal ?? controller.signal,
    beginCommit: beginCommit(context),
  };
}

function invocationContext(
  context: IntegrationInvocationContext | undefined,
): PluginSdkInvocationContext {
  const controller = new AbortController();
  return {
    signal: context?.signal ?? controller.signal,
    writeApproved: context?.writeApproved === true,
    beginCommit: beginCommit(context),
  };
}

async function invokeBoundary<A>(
  operation: () => unknown | Promise<unknown>,
  validate: (value: unknown) => A | Promise<A>,
): Promise<A> {
  try {
    return await validate(await operation());
  } catch (error) {
    if (
      isRecord(error) &&
      (error._tag === "PluginFailure" || error._tag === "ExternalCommitOutcomeUnknown") &&
      typeof error.message === "string" &&
      error.message.trim() &&
      error.message.length <= 1_024
    ) {
      throw new IntegrationProviderPublicError(error.message);
    }
    throw error;
  }
}

function adaptProvider(
  provider: PluginSdkProvider,
  tools: ReadonlyArray<IntegrationProviderTool>,
): IntegrationProvider {
  return {
    id: provider.id,
    tools,
    status: (context) =>
      invokeBoundary(
        () => provider.status({ signal: context?.signal ?? new AbortController().signal }),
        validateStatusResult,
      ),
    ...(provider.prepare
      ? {
          prepare: (context) =>
            invokeBoundary(() => provider.prepare!(lifecycleContext(context)), validateVoidResult),
        }
      : {}),
    ...(provider.connect
      ? {
          connect: (capabilities, context, submission) =>
            invokeBoundary(
              () => provider.connect!(capabilities, lifecycleContext(context), submission),
              validateConnectResult,
            ),
        }
      : {}),
    ...(provider.poll
      ? {
          poll: (flowId, context) =>
            invokeBoundary(
              () => provider.poll!(flowId, lifecycleContext(context)),
              validatePollResult,
            ),
        }
      : {}),
    ...(provider.disconnect
      ? {
          disconnect: (context) =>
            invokeBoundary(
              () => provider.disconnect!(lifecycleContext(context)),
              validateVoidResult,
            ),
        }
      : {}),
    invoke: (toolName, input, context) => {
      if (!isRecord(input)) {
        return Promise.reject(new Error(`Plugin SDK tool ${toolName} input must be an object.`));
      }
      return invokeBoundary(
        () => provider.invoke(toolName, input as JsonObject, invocationContext(context)),
        (value) => validateJsonValue(value, "Plugin SDK invocation result"),
      );
    },
    ...(provider.close
      ? { close: () => invokeBoundary(() => provider.close!(), validateVoidResult) }
      : {}),
  };
}

function admitProvider(value: Record<string, unknown>, expectedId: string): PluginSdkProvider {
  const id = value.id;
  const status = value.status;
  const invoke = value.invoke;
  if (id !== expectedId || typeof status !== "function" || typeof invoke !== "function") {
    throw new Error("Invalid provider shape.");
  }
  const prepare = value.prepare;
  const connect = value.connect;
  const poll = value.poll;
  const disconnect = value.disconnect;
  const close = value.close;
  for (const hook of [prepare, connect, poll, disconnect, close]) {
    if (hook !== undefined && typeof hook !== "function") {
      throw new Error("Invalid optional provider hook.");
    }
  }
  return {
    id,
    status: status.bind(value) as PluginSdkProvider["status"],
    invoke: invoke.bind(value) as PluginSdkProvider["invoke"],
    ...(typeof prepare === "function"
      ? { prepare: prepare.bind(value) as NonNullable<PluginSdkProvider["prepare"]> }
      : {}),
    ...(typeof connect === "function"
      ? { connect: connect.bind(value) as NonNullable<PluginSdkProvider["connect"]> }
      : {}),
    ...(typeof poll === "function"
      ? { poll: poll.bind(value) as NonNullable<PluginSdkProvider["poll"]> }
      : {}),
    ...(typeof disconnect === "function"
      ? { disconnect: disconnect.bind(value) as NonNullable<PluginSdkProvider["disconnect"]> }
      : {}),
    ...(typeof close === "function"
      ? { close: close.bind(value) as NonNullable<PluginSdkProvider["close"]> }
      : {}),
  };
}

function installedFiles(artifact: VerifiedPluginSdkArtifact): Readonly<Record<string, Uint8Array>> {
  const manifest = Buffer.from(`${JSON.stringify(artifact.manifest, null, 2)}\n`, "utf8");
  return {
    ".tritonai-plugin/plugin.json": manifest,
    ...artifact.skillFiles,
  };
}

async function importPluginModule(moduleUrl: string, timeoutMs: number): Promise<PluginSdkModule> {
  const loaded = await Effect.runPromise(
    Effect.promise(() => import(moduleUrl)).pipe(Effect.timeoutOption(timeoutMs)),
  );
  return Option.match(loaded, {
    onNone: () => {
      throw new PluginSdkQuarantineError();
    },
    onSome: (module) => module as PluginSdkModule,
  });
}

async function closeRejectedProvider(value: unknown, timeoutMs: number): Promise<void> {
  try {
    if (!isRecord(value)) return;
    const close = value.close;
    if (typeof close !== "function") return;
    const result = close.call(value) as unknown;
    await Effect.runPromise(
      Effect.promise(() => Promise.resolve(result)).pipe(Effect.timeoutOption(timeoutMs)),
    );
  } catch {
    // Admission already failed. Cleanup is bounded and best-effort before quarantine.
  }
}

export async function loadPluginSdkIntegration(input: {
  readonly files: ReadonlyArray<PluginSdkArtifactFile>;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly expected: { readonly id: string; readonly version: string };
  readonly hostNodeVersion?: string | null;
  readonly admissionTimeoutMs?: number;
}): Promise<IntegrationPackage> {
  const admissionTimeoutMs = input.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
  if (!Number.isSafeInteger(admissionTimeoutMs) || admissionTimeoutMs <= 0) {
    throw new Error("Plugin SDK admission timeout must be a positive integer.");
  }
  let created: unknown = undefined;
  try {
    const artifact = verifyPluginSdkArtifact(
      input.files,
      input.hostNodeVersion === undefined ? {} : { hostNodeVersion: input.hostNodeVersion },
    );
    if (
      artifact.sdkManifest.id !== input.expected.id ||
      artifact.sdkManifest.version !== input.expected.version
    ) {
      throw new Error("Plugin SDK artifact identity does not match its composition.");
    }

    const configurationSchema = compileJsonSchema(artifact.sdkManifest.configurationSchema);
    const configuration = await Schema.decodeUnknownPromise(configurationSchema)(
      input.configuration,
      { errors: "all", onExcessProperty: "error" },
    );
    if (!isRecord(configuration)) {
      throw new Error("Plugin SDK configuration must decode to an object.");
    }
    const tools = artifact.sdkManifest.tools.map(
      (tool): IntegrationProviderTool => ({
        name: tool.name,
        description: tool.description,
        input: compileJsonSchema(tool.inputSchema),
        readOnly: tool.effect === "read",
        destructive: tool.destructive,
        idempotent: tool.idempotent,
        openWorld: tool.openWorld,
      }),
    );

    const moduleUrl = `data:text/javascript;base64,${Buffer.from(artifact.entryBytes).toString("base64")}#artifact-sha256=${artifact.descriptorSha256}`;
    const loaded = await importPluginModule(moduleUrl, admissionTimeoutMs);
    if (typeof loaded.createIntegrationProvider !== "function") {
      throw new Error("Plugin SDK provider factory is missing.");
    }
    created = loaded.createIntegrationProvider({
      secrets: secretStore(input.secrets, artifact.sdkManifest.id),
      configuration: configuration as JsonObject,
    });
    if (isPromiseLike(created) || !isRecord(created)) throw new Error("Invalid provider factory.");
    const provider = admitProvider(created, artifact.sdkManifest.provider);
    return {
      manifest: artifact.manifest,
      bundledFiles: installedFiles(artifact),
      provider: adaptProvider(provider, tools),
    };
  } catch (error) {
    await closeRejectedProvider(created, admissionTimeoutMs);
    throw new PluginSdkQuarantineError(error);
  }
}
