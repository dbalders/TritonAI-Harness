// @effect-diagnostics nodeBuiltinImport:off -- Pipe frames are bounded before decoding untrusted worker bytes.
import * as NodeBuffer from "node:buffer";
import {
  canonicalJson,
  isRecord,
  validateJsonValue,
  type JsonObject,
  type JsonValue,
} from "@t3tools/shared/pluginSdkContract";

export const PLUGIN_BROKER_PROTOCOL = "tritonai.plugin-broker/v1";
export const MAX_PLUGIN_BROKER_FRAME_BYTES = 512 * 1024;

export interface PluginBrokerOperationRequest {
  readonly protocol: typeof PLUGIN_BROKER_PROTOCOL;
  readonly requestId: number;
  readonly kind: "operation";
  readonly operationId: string;
  readonly parameters: JsonObject;
}

export function decodePluginBrokerOperation(value: unknown): PluginBrokerOperationRequest {
  const data = validateJsonValue(value, "Plugin broker operation");
  if (
    !isRecord(data) ||
    Object.keys(data).length !== 5 ||
    data.protocol !== PLUGIN_BROKER_PROTOCOL ||
    data.kind !== "operation" ||
    !Number.isSafeInteger(data.requestId) ||
    Number(data.requestId) < 1 ||
    Number(data.requestId) > 2_147_483_647 ||
    typeof data.operationId !== "string" ||
    data.operationId.length > 128 ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(data.operationId) ||
    !isRecord(data.parameters)
  ) {
    throw new Error("Invalid plugin broker operation.");
  }
  return {
    protocol: PLUGIN_BROKER_PROTOCOL,
    requestId: Number(data.requestId),
    kind: "operation",
    operationId: data.operationId,
    parameters: data.parameters as JsonObject,
  };
}

export function encodePluginBrokerFrame(value: JsonValue): Uint8Array {
  const payload = NodeBuffer.Buffer.from(canonicalJson(value), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > MAX_PLUGIN_BROKER_FRAME_BYTES) {
    throw new Error("Plugin broker frame exceeds its byte limit.");
  }
  const frame = NodeBuffer.Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class PluginBrokerFrameDecoder {
  readonly #header = NodeBuffer.Buffer.alloc(4);
  #headerBytes = 0;
  #payload: Uint8Array | null = null;
  #payloadBytes = 0;
  #failed = false;

  push(chunk: Uint8Array): ReadonlyArray<JsonValue> {
    if (this.#failed) throw new Error("Plugin broker decoder is closed.");
    const messages: JsonValue[] = [];
    let offset = 0;
    try {
      while (offset < chunk.byteLength) {
        if (this.#payload === null) {
          const count = Math.min(4 - this.#headerBytes, chunk.byteLength - offset);
          this.#header.set(chunk.subarray(offset, offset + count), this.#headerBytes);
          this.#headerBytes += count;
          offset += count;
          if (this.#headerBytes < 4) continue;
          const length = this.#header.readUInt32BE(0);
          if (length === 0 || length > MAX_PLUGIN_BROKER_FRAME_BYTES) {
            throw new Error("Plugin broker frame exceeds its byte limit.");
          }
          this.#payload = new Uint8Array(length);
          this.#payloadBytes = 0;
        }
        const count = Math.min(
          this.#payload.byteLength - this.#payloadBytes,
          chunk.byteLength - offset,
        );
        this.#payload.set(chunk.subarray(offset, offset + count), this.#payloadBytes);
        this.#payloadBytes += count;
        offset += count;
        if (this.#payloadBytes !== this.#payload.byteLength) continue;
        if (messages.length >= 16) throw new Error("Plugin broker frame burst exceeds its limit.");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(this.#payload);
        messages.push(validateJsonValue(JSON.parse(text), "Plugin broker frame"));
        this.#payload = null;
        this.#headerBytes = 0;
        this.#payloadBytes = 0;
      }
      return messages;
    } catch (cause) {
      this.#failed = true;
      this.#payload = null;
      throw cause;
    }
  }

  end(): void {
    const incomplete = this.#headerBytes !== 0 || this.#payload !== null;
    this.#failed = true;
    this.#payload = null;
    if (incomplete) throw new Error("Plugin broker pipe ended during a frame.");
  }
}
