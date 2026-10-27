// @effect-diagnostics nodeBuiltinImport:off -- Only host-reviewed canonical policy bytes can select broker recipes.
import * as NodeCrypto from "node:crypto";
import type { VerifiedIsolatedPluginSdkArtifact } from "@t3tools/shared/pluginSdkArtifact";
import {
  isRecord,
  validateJsonValue,
  type JsonObject,
  type JsonValue,
} from "@t3tools/shared/pluginSdkContract";
import { IntegrationProviderPublicError } from "../IntegrationRegistry.ts";
import type { ReviewedPluginBrokerOperation } from "./PluginBrokerChannel.ts";

const REVIEWED_POLICY_FILES: Readonly<Record<string, string>> = Object.freeze({
  "synthetic-api-key": "5cffd30b33078ee2f9bb916a605ef310ce8729bf74eddf3b04f4201c1c9cab68",
  "kuali-build": "050f7ab55b4af7d6cce7db5d77d5fbe27e964cd10396688dba722d12b5a70b69",
});

interface Binding {
  readonly literal?: JsonValue;
  readonly input?: string;
  readonly default?: JsonValue;
  readonly transform?: "lowercase-id" | "kuali-form-data" | "kuali-document-filters";
}
interface Operation {
  readonly id: string;
  readonly tool: string;
  readonly effect: "read" | "write";
  readonly capabilities: ReadonlyArray<string>;
  readonly recipe: {
    readonly kind: "graphql" | "synthetic-items-list" | "synthetic-items-put";
    readonly document?: string;
    readonly variables?: Readonly<Record<string, Binding>>;
  };
  readonly precondition?: { readonly kind: string };
}
interface ReviewedPolicy {
  readonly id: string;
  readonly version: number;
  readonly credential: {
    readonly capabilities: ReadonlyArray<string>;
    readonly requiredCapabilities: ReadonlyArray<string>;
  };
  readonly operations: ReadonlyArray<Operation>;
}
export type KualiBrokerTransport = (input: {
  readonly credential: string;
  readonly document: string;
  readonly variables: JsonObject;
  readonly signal: AbortSignal;
}) => Promise<JsonValue>;

function fail(message: string): never {
  throw new IntegrationProviderPublicError(message, { unchanged: true });
}
const id = (value: JsonValue | undefined) =>
  typeof value === "string" && /^[a-f0-9]{24}$/iu.test(value)
    ? value.toLowerCase()
    : fail("The Kuali identifier is invalid.");
const control = (value: string, whitespace = false) =>
  [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return (code <= 31 && !(whitespace && [9, 10, 13].includes(code))) || code === 127;
  });

function formData(value: JsonValue | undefined, consent: JsonValue | undefined): JsonObject {
  if (!isRecord(value) || Object.keys(value).length > 100) fail("The Kuali form data is invalid.");
  const result: Record<string, JsonValue> = Object.create(null);
  const stack: { value: JsonValue; depth: number }[] = [];
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.startsWith("data.") ? key.slice(5) : key;
    if (
      !/^(?:data\.)?[A-Za-z0-9_-]{1,128}$/u.test(key) ||
      ["__proto__", "constructor", "prototype"].includes(normalized) ||
      Object.hasOwn(result, normalized)
    ) {
      fail("The Kuali form field is invalid or duplicated.");
    }
    result[normalized] = item;
    stack.push({ value: item, depth: 1 });
  }
  let nodes = 0;
  while (stack.length) {
    const { value: child, depth } = stack.pop()!;
    if (++nodes > 5_000 || depth > 16) fail("The Kuali form data exceeds its limits.");
    if (child === null) {
      if (consent !== true) fail("Clearing a Kuali value requires explicit null confirmation.");
    } else if (typeof child === "string") {
      if (child.length > 32_768 || control(child, true)) fail("The Kuali form text is invalid.");
    } else if (typeof child === "object") {
      const entries = Object.entries(child);
      if (entries.length > (Array.isArray(child) ? 500 : 200))
        fail("The Kuali form data exceeds its limits.");
      for (const [key, item] of entries) {
        if (
          !Array.isArray(child) &&
          (!key.length ||
            key.length > 128 ||
            control(key) ||
            ["__proto__", "constructor", "prototype"].includes(key))
        )
          fail("The nested Kuali form field is invalid.");
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
  return result;
}

function variables(operation: Operation, input: JsonObject): JsonObject {
  const values: Record<string, JsonValue> = Object.create(null);
  for (const [key, binding] of Object.entries(operation.recipe.variables ?? {})) {
    let value = Object.hasOwn(binding, "literal")
      ? binding.literal
      : binding.input === "$"
        ? input
        : (input[binding.input!] ?? binding.default);
    switch (binding.transform) {
      case "lowercase-id":
        value = id(value);
        break;
      case "kuali-form-data":
        value = formData(value, input.confirmNullValues);
        break;
      case "kuali-document-filters": {
        const operators: JsonValue[] = [];
        if (input.workflowStatus !== undefined)
          operators.push({ field: "meta.workflowStatus", type: "IS", value: input.workflowStatus });
        if (input.updatedAfter !== undefined)
          operators.push({
            field: "meta.updatedAt",
            type: "RANGE",
            min: String(input.updatedAfter),
          });
        value = operators.length ? { type: "AND", operators } : null;
        break;
      }
    }
    if (value === undefined) fail("The Kuali recipe input is missing.");
    values[key] = value;
  }
  if (
    Buffer.byteLength(JSON.stringify({ query: operation.recipe.document, variables: values })) >
    65_536
  ) {
    fail("The Kuali request exceeds its byte limit.");
  }
  return values;
}

export function createReviewedPluginBroker(input: {
  readonly artifact: VerifiedIsolatedPluginSdkArtifact;
  readonly transport: KualiBrokerTransport;
  readonly items: Map<string, string>;
}) {
  const { artifact } = input;
  const pluginId = artifact.sdkManifest.id;
  const policySha256 = REVIEWED_POLICY_FILES[pluginId];
  // The release dependency is not authority. A host source change must independently admit new bytes.
  if (
    !policySha256 ||
    NodeCrypto.createHash("sha256").update(artifact.policyBytes).digest("hex") !== policySha256 ||
    artifact.policyFileSha256 !== policySha256
  )
    throw new Error("Plugin broker policy is not host reviewed.");
  const policy = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(artifact.policyBytes),
  ) as ReviewedPolicy;
  const operations = new Map(policy.operations.map((operation) => [operation.id, operation]));
  const find = (operation: ReviewedPluginBrokerOperation) => {
    const recipe = operations.get(operation.id);
    if (!recipe || recipe.tool !== operation.toolName || recipe.effect !== operation.effect)
      throw new Error("Unknown reviewed operation.");
    return recipe;
  };
  const send = (credential: string, document: string, values: JsonObject, signal: AbortSignal) => {
    signal.throwIfAborted();
    return input.transport({ credential, document, variables: values, signal });
  };
  const projectCommittedResult = ({
    operation,
    parameters,
    result,
  }: {
    readonly operation: ReviewedPluginBrokerOperation;
    readonly parameters: JsonObject;
    readonly result: JsonValue;
  }): JsonValue => {
    find(operation);
    if (pluginId === "synthetic-api-key") return result;
    // A malformed response after admission remains ambiguous. Never mark it unchanged.
    if (!isRecord(result)) throw new Error("The admitted Kuali mutation receipt is invalid.");
    switch (operation.toolName) {
      case "kuali-build.documents.update": {
        const receipt = result.updateDocument;
        if (
          !isRecord(receipt) ||
          typeof receipt.id !== "string" ||
          !/^[a-f0-9]{24}$/iu.test(receipt.id) ||
          receipt.id.toLowerCase() !== id(parameters.documentId)
        ) {
          throw new Error("The admitted Kuali update could not be confirmed.");
        }
        return {
          document: { id: receipt.id.toLowerCase() },
          updatedFormKeys: Object.keys(formData(parameters.data, parameters.confirmNullValues)),
          precondition: { expectedUpdatedAt: parameters.expectedUpdatedAt! },
        };
      }
      case "kuali-build.documents.drafts.initialize": {
        const receipt = result.initializeWorkflow;
        if (
          !isRecord(receipt) ||
          typeof receipt.actionId !== "string" ||
          !/^[a-f0-9]{24}$/iu.test(receipt.actionId)
        )
          throw new Error("The admitted Kuali initialization could not be confirmed.");
        return {
          appId: id(parameters.appId),
          actionId: receipt.actionId.toLowerCase(),
          state: "draft_initialized",
          nextTool: "kuali-build.documents.drafts.resolve",
          atomic: false,
        };
      }
      case "kuali-build.documents.submit": {
        const receipt = result.submitDocument;
        if (typeof receipt !== "string" || !receipt.length || receipt.length > 128)
          throw new Error("The admitted Kuali submission could not be confirmed.");
        return {
          actionId: id(parameters.actionId),
          documentId: id(parameters.documentId),
          result: receipt,
          state: "submitted",
          workflowStarted: true,
          atomic: false,
        };
      }
      default:
        throw new Error("No reviewed Kuali mutation receipt projection.");
    }
  };
  return {
    policyId: policy.id,
    policyVersion: policy.version,
    policySha256,
    capabilities: policy.credential.capabilities,
    requiredCapabilities: policy.credential.requiredCapabilities,
    operations: policy.operations,
    projectCommittedResult,
    async prepare({
      operation,
      parameters,
      signal,
      credential,
    }: {
      readonly operation: ReviewedPluginBrokerOperation;
      readonly parameters: JsonObject;
      readonly signal: AbortSignal;
      readonly credential: string;
    }) {
      const recipe = find(operation);
      if (recipe.recipe.kind !== "graphql") {
        if (
          recipe.recipe.kind === "synthetic-items-put" &&
          typeof parameters.id === "string" &&
          !input.items.has(parameters.id) &&
          input.items.size >= 256
        )
          fail("The synthetic item store is full.");
        return;
      }
      variables(recipe, parameters);
      switch (recipe.precondition?.kind) {
        case "kuali-document-version": {
          const current = await send(
            credential,
            "query KualiBuildDocumentVersion($id: ID!) { document(id: $id) { id meta } }",
            { id: id(parameters.documentId) },
            signal,
          );
          const document = isRecord(current) ? current.document : null;
          const meta = isRecord(document) ? document.meta : null;
          const version = isRecord(meta) ? meta.updatedAt : null;
          if (
            !isRecord(document) ||
            typeof document.id !== "string" ||
            document.id.toLowerCase() !== id(parameters.documentId) ||
            !(
              (typeof version === "string" && version.length > 0) ||
              (typeof version === "number" && Number.isSafeInteger(version))
            ) ||
            typeof parameters.expectedUpdatedAt !== "string" ||
            String(version) !== parameters.expectedUpdatedAt
          ) {
            fail(
              "The Kuali document changed or its version could not be verified. Read it again before updating.",
            );
          }
          break;
        }
        case "kuali-app-exists": {
          const current = await send(
            credential,
            "query KualiBuildApp($id: ID) { app(id: $id) { id name } }",
            { id: id(parameters.appId) },
            signal,
          );
          const app = isRecord(current) ? current.app : null;
          if (
            !isRecord(app) ||
            typeof app.id !== "string" ||
            app.id.toLowerCase() !== id(parameters.appId)
          )
            fail("The Kuali app could not be verified.");
          break;
        }
        case "kuali-draft-binding": {
          const current = await send(
            credential,
            "query KualiBuildDraftAction($actionId: String!) { action(actionId: $actionId) { id appId document { id } } }",
            { actionId: id(parameters.actionId) },
            signal,
          );
          const action = isRecord(current) ? current.action : null;
          const document = isRecord(action) ? action.document : null;
          if (
            !isRecord(action) ||
            typeof action.id !== "string" ||
            action.id.toLowerCase() !== id(parameters.actionId) ||
            !isRecord(document) ||
            typeof document.id !== "string" ||
            document.id.toLowerCase() !== id(parameters.documentId)
          )
            fail("The Kuali draft does not match this document.");
          break;
        }
      }
      signal.throwIfAborted();
    },
    async execute({
      operation,
      parameters,
      signal,
      credential,
    }: {
      readonly operation: ReviewedPluginBrokerOperation;
      readonly parameters: JsonObject;
      readonly signal: AbortSignal;
      readonly credential: string;
    }): Promise<JsonValue> {
      const recipe = find(operation);
      signal.throwIfAborted();
      let result: JsonValue;
      if (recipe.recipe.kind === "synthetic-items-list")
        result = { items: [...input.items].map(([id, value]) => ({ id, value })) };
      else if (recipe.recipe.kind === "synthetic-items-put") {
        if (typeof parameters.id !== "string" || typeof parameters.value !== "string")
          fail("The synthetic item is invalid.");
        input.items.set(parameters.id, parameters.value);
        result = { id: parameters.id, value: parameters.value };
      } else
        result = validateJsonValue(
          await send(credential, recipe.recipe.document!, variables(recipe, parameters), signal),
          "Kuali broker response",
        );
      if (operation.effect === "write") projectCommittedResult({ operation, parameters, result });
      return result;
    },
  };
}
