"use strict";

const { pathToFileURL } = require("node:url");
const MAX_FRAME_BYTES = 524288;
const WORKER_PROTOCOL = "tritonai.plugin-worker/v1";
const BROKER_PROTOCOL = "tritonai.plugin-broker/v1";
const stringify = JSON.stringify;
const parse = JSON.parse;
const exit = process.exit.bind(process);
const write = process.stdout.write.bind(process.stdout);
const decoder = new TextDecoder("utf-8", { fatal: true });
const header = Buffer.alloc(4);
let headerBytes = 0;
let payload = null;
let payloadBytes = 0;
let state = "initial";
let provider;
let pending = null;
let nextRequestId = 1;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value, keys) {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function send(value) {
  const bytes = Buffer.from(stringify(value), "utf8");
  if (!bytes.length || bytes.length > MAX_FRAME_BYTES) throw Error("Frame too large");
  const frame = Buffer.allocUnsafe(bytes.length + 4);
  frame.writeUInt32BE(bytes.length);
  bytes.copy(frame, 4);
  return new Promise((resolve, reject) => {
    write(frame, (error) => (error ? reject(error) : resolve()));
  });
}

function fail() {
  if (state === "failed" || state === "finished") return;
  state = "failed";
  pending?.reject(Error("Plugin worker channel closed"));
  pending = null;
  void send({ protocol: WORKER_PROTOCOL, kind: "error", code: "worker_failed" }).then(
    () => exit(1),
    () => exit(1),
  );
}

const broker = Object.freeze({
  request(operationId, parameters) {
    if (
      state !== "running" ||
      pending !== null ||
      nextRequestId !== 1 ||
      typeof operationId !== "string" ||
      !object(parameters)
    ) {
      return Promise.reject(Error("No plugin operation is available"));
    }
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
      pending = { requestId, resolve, reject };
      void send({
        protocol: BROKER_PROTOCOL,
        requestId,
        kind: "operation",
        operationId,
        parameters,
      }).catch(fail);
    });
  },
});

async function initialize(message) {
  if (
    !fields(message, ["protocol", "kind", "pluginPath", "pluginId", "configuration"]) ||
    typeof message.pluginPath !== "string" ||
    !message.pluginPath.startsWith("/") ||
    message.pluginPath.length > 4096 ||
    typeof message.pluginId !== "string" ||
    !object(message.configuration)
  )
    throw Error("Invalid initialization");
  const loaded = await import(pathToFileURL(message.pluginPath).href);
  if (typeof loaded.createIntegrationProvider !== "function") throw Error("No SDK2 factory");
  provider = await loaded.createIntegrationProvider({
    configuration: message.configuration,
    broker,
  });
  if (
    !object(provider) ||
    provider.id !== message.pluginId ||
    typeof provider.invoke !== "function" ||
    (provider.close !== undefined && typeof provider.close !== "function")
  ) {
    throw Error("Invalid SDK2 provider");
  }
  state = "ready";
  await send({ protocol: WORKER_PROTOCOL, kind: "ready" });
}

async function invoke(message) {
  if (
    !fields(message, ["protocol", "kind", "toolName", "input"]) ||
    typeof message.toolName !== "string" ||
    !object(message.input)
  ) {
    throw Error("Invalid invocation");
  }
  const value = await provider.invoke(message.toolName, message.input, {
    signal: new AbortController().signal,
  });
  if (pending !== null) throw Error("Plugin operation is still pending");
  await provider.close?.();
  await send({ protocol: WORKER_PROTOCOL, kind: "result", value });
  state = "finished";
  exit(0);
}

function receive(message) {
  if (!object(message)) throw Error("Invalid message");
  if (message.protocol === BROKER_PROTOCOL) {
    const request = pending;
    if (state !== "running" || request === null || message.requestId !== request.requestId) {
      throw Error("Unmatched broker result");
    }
    pending = null;
    if (message.kind === "result" && fields(message, ["protocol", "requestId", "kind", "value"])) {
      request.resolve(message.value);
    } else if (
      message.kind === "error" &&
      fields(message, ["protocol", "requestId", "kind", "error"])
    ) {
      request.reject(Error("Host operation failed"));
    } else throw Error("Invalid broker result");
    return;
  }
  if (message.protocol !== WORKER_PROTOCOL) throw Error("Unknown worker protocol");
  if (state === "initial" && message.kind === "initialize") {
    state = "initializing";
    void initialize(message).catch(fail);
  } else if (state === "ready" && message.kind === "invoke") {
    state = "running";
    void invoke(message).catch(fail);
  } else throw Error("Unexpected worker message");
}

process.stdin.on("data", (chunk) => {
  try {
    let offset = 0;
    while (offset < chunk.length) {
      if (payload === null) {
        const count = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count);
        offset += count;
        headerBytes += count;
        if (headerBytes < 4) continue;
        const length = header.readUInt32BE();
        if (!length || length > MAX_FRAME_BYTES) throw Error("Invalid frame length");
        payload = Buffer.allocUnsafe(length);
        payloadBytes = 0;
      }
      const count = Math.min(payload.length - payloadBytes, chunk.length - offset);
      chunk.copy(payload, payloadBytes, offset, offset + count);
      offset += count;
      payloadBytes += count;
      if (payloadBytes !== payload.length) continue;
      const message = parse(decoder.decode(payload));
      payload = null;
      payloadBytes = 0;
      headerBytes = 0;
      receive(message);
    }
  } catch {
    fail();
  }
});
process.stdin.on("end", fail);
process.stdin.on("error", fail);
process.stdout.on("error", () => exit(1));
