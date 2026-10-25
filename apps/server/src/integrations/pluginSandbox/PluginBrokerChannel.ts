import {
  canonicalJson,
  isRecord,
  validateJsonValue,
  type JsonObject,
  type JsonValue,
} from "@t3tools/shared/pluginSdkContract";
import type { IntegrationInvocationContext } from "../IntegrationRegistry.ts";
import { snapshotIntegrationInput } from "../IntegrationWriteApproval.ts";
import { decodePluginBrokerOperation, encodePluginBrokerFrame } from "./PluginBrokerProtocol.ts";

export interface PluginBrokerBinding {
  readonly pluginId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly credentialGeneration: number;
  readonly workerGeneration: number;
  readonly artifactSha256: string;
  readonly descriptorSha256: string;
  readonly policySha256: string;
  readonly policyId: string;
  readonly policyVersion: number;
}

export interface ReviewedPluginBrokerOperation {
  readonly id: string;
  readonly toolName: string;
  readonly effect: "read" | "write";
  readonly validate: (input: JsonObject) => void;
}

interface Invocation {
  readonly toolName: string;
  readonly input: JsonObject;
  readonly canonical: string;
  readonly context: IntegrationInvocationContext;
  used: boolean;
  committed: boolean;
  pending: Promise<JsonValue> | null;
}

type ExecuteOperation = (input: {
  readonly binding: PluginBrokerBinding;
  readonly operation: ReviewedPluginBrokerOperation;
  readonly parameters: JsonObject;
  readonly signal: AbortSignal;
}) => Promise<JsonValue>;

export class PluginBrokerChannel {
  readonly #binding: PluginBrokerBinding;
  readonly #operations: ReadonlyMap<string, ReviewedPluginBrokerOperation>;
  readonly #isCurrent: (binding: PluginBrokerBinding) => boolean;
  readonly #execute: ExecuteOperation;
  readonly #terminate: () => void;
  readonly #shutdown = new AbortController();
  #nextRequestId = 1;
  #invocation: Invocation | null = null;

  constructor(input: {
    readonly binding: PluginBrokerBinding;
    readonly reviewedPolicySha256: string;
    readonly operations: ReadonlyArray<ReviewedPluginBrokerOperation>;
    readonly isCurrent: (binding: PluginBrokerBinding) => boolean;
    readonly execute: ExecuteOperation;
    readonly terminate: () => void;
  }) {
    if (
      !/^[a-f0-9]{64}$/u.test(input.reviewedPolicySha256) ||
      input.binding.policySha256 !== input.reviewedPolicySha256 ||
      new Set(input.operations.map((operation) => operation.id)).size !== input.operations.length
    ) {
      throw new Error("Plugin broker policy is not admitted.");
    }
    this.#binding = Object.freeze({ ...input.binding });
    this.#operations = new Map(
      input.operations.map((operation) => [operation.id, Object.freeze({ ...operation })]),
    );
    this.#isCurrent = input.isCurrent;
    this.#execute = input.execute;
    this.#terminate = input.terminate;
  }

  beginInvocation(toolName: string, input: unknown, context: IntegrationInvocationContext): void {
    this.#assertCurrent();
    if (this.#invocation) throw new Error("Plugin broker invocation is already active.");
    context.signal.throwIfAborted();
    const snapshot = snapshotIntegrationInput(input);
    if (!isRecord(snapshot.value)) throw new Error("Plugin broker input must be an object.");
    // The exact admitted input must also fit its pipe envelope before the worker starts.
    encodePluginBrokerFrame({
      protocol: "tritonai.plugin-broker/v1",
      requestId: this.#nextRequestId,
      kind: "operation",
      operationId: `${toolName}.v1`,
      parameters: snapshot.value,
    });
    this.#invocation = {
      toolName,
      input: snapshot.value as JsonObject,
      canonical: snapshot.canonical,
      context,
      used: false,
      committed: false,
      pending: null,
    };
  }

  async operation(value: unknown): Promise<JsonValue> {
    try {
      this.#assertCurrent();
      const request = decodePluginBrokerOperation(value);
      const invocation = this.#invocation;
      const operation = this.#operations.get(request.operationId);
      if (
        request.requestId !== this.#nextRequestId ||
        !invocation ||
        invocation.used ||
        !operation ||
        operation.toolName !== invocation.toolName ||
        canonicalJson(request.parameters) !== invocation.canonical
      ) {
        throw new Error("Plugin broker operation does not match its admitted invocation.");
      }
      invocation.context.signal.throwIfAborted();
      operation.validate(invocation.input);
      invocation.used = true;
      this.#nextRequestId++;
      // Reserve before awaiting commit admission; a second request cannot race this one.
      invocation.pending = this.#run(invocation, operation);
      return await invocation.pending;
    } catch (cause) {
      this.revoke();
      throw cause;
    }
  }

  async #run(invocation: Invocation, operation: ReviewedPluginBrokerOperation): Promise<JsonValue> {
    let signal = invocation.context.signal;
    if (operation.effect === "write") {
      if (!invocation.context.beginCommit) throw new Error("Plugin broker write was not admitted.");
      signal = await invocation.context.beginCommit();
      invocation.committed = true;
    }
    this.#assertCurrent();
    signal.throwIfAborted();
    const transportSignal = AbortSignal.any([signal, this.#shutdown.signal]);
    const result = await this.#execute({
      binding: this.#binding,
      operation,
      parameters: invocation.input,
      signal: transportSignal,
    });
    this.#assertCurrent();
    transportSignal.throwIfAborted();
    const validated = validateJsonValue(result, "Plugin broker result");
    encodePluginBrokerFrame(validated);
    return validated;
  }

  async completeInvocation(workerResult: unknown): Promise<JsonValue> {
    const invocation = this.#invocation;
    if (!invocation) throw new Error("No plugin broker invocation is active.");
    try {
      if (invocation.pending) await invocation.pending;
      this.#assertCurrent();
      if (!invocation.committed) invocation.context.signal.throwIfAborted();
      const result = validateJsonValue(workerResult, "Plugin worker result");
      encodePluginBrokerFrame(result);
      return result;
    } finally {
      this.#invocation = null;
    }
  }

  revoke(): void {
    if (this.#shutdown.signal.aborted) return;
    this.#shutdown.abort(new Error("Plugin broker authority was revoked."));
    this.#terminate();
  }

  #assertCurrent(): void {
    if (this.#shutdown.signal.aborted || !this.#isCurrent(this.#binding)) {
      this.revoke();
      throw new Error("Plugin broker authority is no longer current.");
    }
  }
}
