// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalDate:off -- This Promise adapter owns host credential flows; plugin code never receives this store.
import * as NodeCrypto from "node:crypto";
import {
  verifyIsolatedPluginSdkArtifact,
  type PluginSdkArtifactFile,
  type VerifiedIsolatedPluginSdkArtifact,
} from "@t3tools/shared/pluginSdkArtifact";
import { isRecord, type JsonObject, type JsonValue } from "@t3tools/shared/pluginSdkContract";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  IntegrationProviderPublicError,
  type IntegrationInvocationContext,
  type IntegrationLifecycleContext,
  type IntegrationPackage,
  type IntegrationProvider,
} from "../IntegrationRegistry.ts";
import { scopeIntegrationSecretStore } from "../IntegrationSecretStore.ts";
import {
  integrationCredentialGeneration,
  integrationCredentialMutationPending,
  snapshotIntegrationInput,
} from "../IntegrationWriteApproval.ts";
import { decodeIntegrationToolInput } from "../IntegrationTool.ts";
import { compilePluginJsonSchema } from "../pluginSdk/schema.ts";
import type { PluginBrokerChannel } from "./PluginBrokerChannel.ts";
import { createReviewedPluginBroker, type KualiBrokerTransport } from "./ReviewedPluginBroker.ts";
import { kualiBrokerTransport } from "./KualiBrokerTransport.ts";

export interface IsolatedPluginRuntime {
  readonly workerNodeVersion: string;
  invoke(input: {
    readonly artifact: VerifiedIsolatedPluginSdkArtifact;
    readonly configuration: JsonObject;
    readonly toolName: string;
    readonly parameters: JsonObject;
    readonly context: IntegrationInvocationContext;
    readonly authority: Omit<ConstructorParameters<typeof PluginBrokerChannel>[0], "terminate">;
  }): Promise<JsonValue>;
}
interface Credential {
  readonly apiKey: string;
  readonly capabilities: readonly string[];
  readonly migrate: boolean;
}
function failure(message: string): never {
  throw new IntegrationProviderPublicError(message, { unchanged: true });
}

export async function loadIsolatedPluginIntegration(input: {
  readonly files: readonly PluginSdkArtifactFile[];
  readonly expected: { readonly id: string; readonly version: string };
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly runtime: IsolatedPluginRuntime;
  readonly transport?: KualiBrokerTransport;
}): Promise<IntegrationPackage> {
  const artifact = verifyIsolatedPluginSdkArtifact(input.files, {
    workerNodeVersion: input.runtime.workerNodeVersion,
  });
  if (
    artifact.sdkManifest.id !== input.expected.id ||
    artifact.sdkManifest.version !== input.expected.version
  )
    throw new Error("Isolated plugin identity does not match its composition.");
  const configuration = snapshotIntegrationInput(
    await Schema.decodeUnknownPromise(
      compilePluginJsonSchema(artifact.sdkManifest.configurationSchema),
    )(snapshotIntegrationInput(input.configuration).value, {
      errors: "all",
      onExcessProperty: "error",
    }),
  ).value;
  if (!isRecord(configuration)) throw new Error("Plugin configuration must be an object.");
  const items = new Map<string, string>();
  const transport = input.transport ?? kualiBrokerTransport;
  const broker = createReviewedPluginBroker({ artifact, transport, items });
  const pluginId = artifact.sdkManifest.id;
  const kuali = pluginId === "kuali-build";
  const label = kuali ? "UC San Diego Kuali Build" : "synthetic API key";
  const suffix = kuali ? "api-key" : "connection";
  const scoped = scopeIntegrationSecretStore(input.secrets, pluginId);
  const connectionId = NodeCrypto.randomUUID();
  const controllers = new Set<AbortController>();
  const flows = new Map<
    string,
    {
      readonly capabilities: readonly string[];
      readonly generation: number;
      readonly expires: number;
    }
  >();
  let generation = 1;
  let workerGeneration = 0;
  let closed = false;
  const open = () => {
    if (closed) failure("The plugin connection is closed.");
  };
  const invalidate = () => {
    generation++;
    flows.clear();
    for (const controller of controllers) controller.abort();
    items.clear();
  };
  const capabilities = (value: unknown): readonly string[] => {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > broker.capabilities.length ||
      new Set(value).size !== value.length ||
      value.some(
        (capability) => typeof capability !== "string" || !broker.capabilities.includes(capability),
      ) ||
      broker.requiredCapabilities.some((capability) => !value.includes(capability))
    )
      failure("The plugin connection capabilities are invalid.");
    return broker.capabilities.filter((capability) => value.includes(capability));
  };
  const apiKey = (value: unknown): string => {
    if (
      typeof value !== "string" ||
      value.length < (kuali ? 16 : 1) ||
      value.length > (kuali ? 8_192 : 256) ||
      [...value].some(
        (character) => character.codePointAt(0)! <= 31 || character.codePointAt(0) === 127,
      ) ||
      (kuali && /\s/u.test(value))
    )
      failure("The API key format is invalid.");
    return value;
  };
  const read = async (): Promise<{
    readonly encoded: string | null;
    readonly credential: Credential | null;
    readonly credentialGeneration: number;
  }> => {
    const credentialGeneration = integrationCredentialGeneration(pluginId);
    if (integrationCredentialMutationPending(pluginId))
      failure("The plugin credential is changing.");
    const stored = await Effect.runPromise(scoped.get(suffix));
    if (
      credentialGeneration !== integrationCredentialGeneration(pluginId) ||
      integrationCredentialMutationPending(pluginId)
    )
      failure("The plugin credential changed during lookup.");
    if (Option.isNone(stored)) return { encoded: null, credential: null, credentialGeneration };
    if (stored.value.byteLength > 12_000) failure("The stored plugin credential is invalid.");
    const encoded = new TextDecoder("utf-8", { fatal: true }).decode(stored.value);
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      return failure("The stored plugin credential is invalid.");
    }
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).some(
        (key) =>
          !(kuali ? ["version", "apiKey", "capabilities"] : ["apiKey", "capabilities"]).includes(
            key,
          ),
      ) ||
      (kuali && parsed.version !== 1)
    )
      failure("The stored plugin credential is invalid.");
    let granted = parsed.capabilities;
    let migrate = false;
    if (
      kuali &&
      Array.isArray(granted) &&
      granted.includes("kuali-build.read") &&
      granted.some(
        (value) =>
          value === "kuali-build.documents.write" || value === "kuali-build.workflows.write",
      )
    ) {
      if (
        new Set(granted).size !== granted.length ||
        granted.some(
          (value) =>
            ![
              "kuali-build.read",
              "kuali-build.documents.write",
              "kuali-build.workflows.write",
            ].includes(value),
        )
      )
        failure("The stored plugin credential is invalid.");
      granted =
        granted.includes("kuali-build.documents.write") &&
        granted.includes("kuali-build.workflows.write")
          ? broker.capabilities
          : ["kuali-build.read"];
      migrate = true;
    }
    return {
      encoded,
      credentialGeneration,
      credential: { apiKey: apiKey(parsed.apiKey), capabilities: capabilities(granted), migrate },
    };
  };
  const verifyCredential = async (credential: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!kuali) return;
    const data = await transport({
      credential,
      document: "query KualiBuildApps { apps { id name } }",
      variables: {},
      signal,
    });
    if (
      !isRecord(data) ||
      !Array.isArray(data.apps) ||
      data.apps.some(
        (app) => !isRecord(app) || typeof app.id !== "string" || typeof app.name !== "string",
      )
    )
      failure("Kuali did not verify this connection.");
    signal.throwIfAborted();
  };
  const persist = async (
    encoded: string | null,
    context: IntegrationLifecycleContext | undefined,
    expectedGeneration = generation,
  ) => {
    open();
    if (generation !== expectedGeneration)
      failure("The plugin connection changed before credential persistence.");
    if (!context) failure("The host did not admit this credential change.");
    context.signal.throwIfAborted();
    const signal = await context.beginCommit();
    signal.throwIfAborted();
    open();
    if (generation !== expectedGeneration)
      failure("The plugin connection changed before credential persistence.");
    invalidate();
    try {
      await Effect.runPromise(
        encoded === null
          ? scoped.remove(suffix)
          : scoped.set(suffix, new TextEncoder().encode(encoded)),
      );
    } catch (cause) {
      let recovered;
      try {
        recovered = await read();
      } catch (recoveryCause) {
        throw new Error("The plugin credential commit could not be confirmed.", {
          cause: recoveryCause,
        });
      }
      if (recovered.encoded !== encoded) throw cause;
    }
  };
  const encode = (key: string, granted: readonly string[]) =>
    JSON.stringify({ ...(kuali ? { version: 1 } : {}), apiKey: key, capabilities: granted });
  const provider: IntegrationProvider = {
    id: artifact.sdkManifest.provider,
    tools: artifact.sdkManifest.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input: compilePluginJsonSchema(tool.inputSchema),
      readOnly: tool.effect === "read",
      destructive: tool.destructive,
      idempotent: tool.idempotent,
      openWorld: tool.openWorld,
    })),
    async status(context) {
      open();
      const { credential } = await read();
      const signal = context?.signal ?? new AbortController().signal;
      if (credential) await verifyCredential(credential.apiKey, signal);
      return {
        state: credential ? "connected" : "not_connected",
        accountLabel: credential ? label : null,
        grantedCapabilities: credential?.capabilities ?? [],
        message: null,
      };
    },
    async prepare(context) {
      open();
      const { credential } = await read();
      if (credential?.migrate) {
        await verifyCredential(credential.apiKey, context.signal);
        await persist(encode(credential.apiKey, credential.capabilities), context);
      }
    },
    async connect(requested, context, submission) {
      open();
      const granted = capabilities(requested);
      const expectedGeneration = generation;
      if (!context) failure("The connection flow has no host authority.");
      context.signal.throwIfAborted();
      if (!submission) {
        const { credential } = await read();
        if (credential) {
          await verifyCredential(credential.apiKey, context.signal);
          if (
            credential.migrate ||
            JSON.stringify(granted) !== JSON.stringify(credential.capabilities)
          )
            await persist(encode(credential.apiKey, granted), context, expectedGeneration);
          return {
            kind: "connected",
            flowId: NodeCrypto.randomUUID(),
            message: `${label} connected.`,
          };
        }
        for (const [key, flow] of flows) if (flow.expires <= Date.now()) flows.delete(key);
        if (flows.size >= 8) failure("Too many pending plugin connection flows.");
        const flowId = NodeCrypto.randomUUID();
        flows.set(flowId, { capabilities: granted, generation, expires: Date.now() + 600_000 });
        return {
          kind: "api_key",
          flowId,
          label: `${label} API key`,
          placeholder: null,
          message: "Enter the API key for this connection. It stays in the host credential store.",
          ...(kuali
            ? { setupUrl: "https://ucsd.kualibuild.com/build/space/favorites/account/api-keys" }
            : {}),
        };
      }
      const flow = flows.get(submission.flowId);
      flows.delete(submission.flowId);
      if (
        submission.kind !== "api_key" ||
        !flow ||
        flow.generation !== generation ||
        flow.expires <= Date.now() ||
        JSON.stringify(flow.capabilities) !== JSON.stringify(granted)
      )
        failure("The API key flow expired or changed.");
      const credential = apiKey(submission.value);
      await verifyCredential(credential, context.signal);
      await persist(encode(credential, flow.capabilities), context, flow.generation);
      return { kind: "connected", flowId: submission.flowId, message: `${label} connected.` };
    },
    async disconnect(context) {
      open();
      if ((await read()).encoded !== null) await persist(null, context);
      else invalidate();
    },
    async invoke(toolName, value, context) {
      open();
      if (!context) failure("The plugin invocation has no host context.");
      const snapshot = snapshotIntegrationInput(value);
      if (!isRecord(snapshot.value)) failure("The plugin input must be an object.");
      const parameters = snapshot.value as JsonObject;
      const tool = artifact.sdkManifest.tools.find((candidate) => candidate.name === toolName);
      const definition = provider.tools.find((candidate) => candidate.name === toolName);
      if (!tool || !definition) failure("The plugin tool is unknown.");
      await decodeIntegrationToolInput(definition, parameters);
      const { credential, credentialGeneration } = await read();
      if (
        !credential ||
        tool.capabilities.some((capability) => !credential.capabilities.includes(capability))
      )
        failure("The plugin connection did not grant this operation.");
      const controller = new AbortController();
      controllers.add(controller);
      const boundGeneration = generation;
      const boundWorker = ++workerGeneration;
      try {
        return await input.runtime.invoke({
          artifact,
          configuration: configuration as JsonObject,
          toolName,
          parameters,
          context: { ...context, signal: AbortSignal.any([context.signal, controller.signal]) },
          authority: {
            binding: {
              pluginId,
              connectionId,
              connectionGeneration: boundGeneration,
              credentialGeneration,
              workerGeneration: boundWorker,
              artifactSha256: artifact.descriptorSha256,
              descriptorSha256: artifact.descriptorSha256,
              policySha256: broker.policySha256,
              policyId: broker.policyId,
              policyVersion: broker.policyVersion,
            },
            reviewedPolicySha256: broker.policySha256,
            operations: [
              { id: `${toolName}.v1`, toolName, effect: tool.effect, validate: () => {} },
            ],
            isCurrent: (binding) =>
              !closed &&
              generation === binding.connectionGeneration &&
              integrationCredentialGeneration(pluginId) === binding.credentialGeneration &&
              !integrationCredentialMutationPending(pluginId) &&
              !controller.signal.aborted,
            prepare: (operation) => broker.prepare({ ...operation, credential: credential.apiKey }),
            execute: (operation) => broker.execute({ ...operation, credential: credential.apiKey }),
            projectCommittedResult: broker.projectCommittedResult,
          },
        });
      } finally {
        controllers.delete(controller);
      }
    },
    async close() {
      if (!closed) {
        closed = true;
        invalidate();
      }
    },
  };
  return {
    manifest: artifact.manifest,
    provider,
    bundledFiles: {
      ".tritonai-plugin/plugin.json": Buffer.from(
        `${JSON.stringify(artifact.manifest, null, 2)}\n`,
      ),
      ...artifact.skillFiles,
    },
  };
}
