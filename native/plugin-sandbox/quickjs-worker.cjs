"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const createEngine = function createEngine() {
  const bytes = fs.readFileSync(path.join(__dirname, "engine.wasm"));
  if (
    bytes.length > 1000000 ||
    crypto.createHash("sha256").update(bytes).digest("hex") !==
      "382dc56e633017da3f8b76d61efc3ec0d5673cffd6fd2ce06789cef6e37b5fb2"
  )
    throw Error("Module pin refused");
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (
    imports.length !== 6 ||
    imports.some(
      (entry) =>
        entry.module !== "wasi_snapshot_preview1" ||
        entry.kind !== "function" ||
        ![
          "fd_close",
          "clock_time_get",
          "environ_sizes_get",
          "environ_get",
          "fd_write",
          "fd_seek",
        ].includes(entry.name),
    )
  )
    throw Error("Module imports refused");
  let memory;
  let view;
  let importCalls = 0;
  const guard = () => {
    if (++importCalls > 1000) throw Error("Import budget exhausted");
  };
  const range = (pointer, length) => {
    if (!Number.isInteger(pointer) || pointer < 0 || pointer > memory.buffer.byteLength - length)
      throw Error("Import range refused");
  };
  const unavailable = () => {
    guard();
    return 8;
  };
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: {
      fd_close: unavailable,
      fd_write: unavailable,
      fd_seek: unavailable,
      clock_time_get: (_clock, _precision, result) => {
        guard();
        range(result, 8);
        view.setBigUint64(result, 0n, true);
        return 0;
      },
      environ_sizes_get: (count, size) => {
        guard();
        range(count, 4);
        range(size, 4);
        view.setUint32(count, 0, true);
        view.setUint32(size, 0, true);
        return 0;
      },
      environ_get: () => {
        guard();
        return 0;
      },
    },
  });
  const engine = instance.exports;
  memory = engine.memory;
  view = new DataView(memory.buffer);
  if (memory.buffer.byteLength !== 67108864) throw Error("Linear memory mismatch");
  let memoryGrowthDenied = false,
    tableGrowthDenied = false;
  try {
    memory.grow(1);
  } catch {
    memoryGrowthDenied = true;
  }
  try {
    engine.__indirect_function_table.grow(1);
  } catch {
    tableGrowthDenied = true;
  }
  if (!memoryGrowthDenied || !tableGrowthDenied) throw Error("Growth accepted");
  engine.emscripten_stack_init();
  const stackBase = engine.emscripten_stack_get_base();
  const stackEnd = engine.emscripten_stack_get_end();
  if (stackBase - stackEnd !== 262144 || stackEnd !== 0) throw Error("Stack bounds mismatch");
  engine.__set_stack_limits(stackBase, stackEnd);
  engine._initialize();
  if (engine.harness_initialize() !== 0) throw Error("Engine initialization failed");
  return { engine, memory, memoryGrowthDenied, tableGrowthDenied };
};

const MAX = 524288;
const PROTOCOL = "tritonai.plugin-worker/v1";
const BROKER = "tritonai.plugin-broker/v1";
const parse = JSON.parse;
const encode = JSON.stringify;
const decode = new TextDecoder("utf8", { fatal: true });
const buffer = Buffer.allocUnsafe(MAX);
const header = Buffer.alloc(4);
const outbound = Buffer.allocUnsafe(MAX + 4);
let headerLength = 0,
  payloadLength = 0,
  received = 0,
  phase = "initial";
let runtime,
  engine,
  pendingJobs = 0,
  receivedFrames = 0,
  sentFrames = 0;

function fail() {
  process.stderr.write("Constrained plugin worker failed at " + phase + "\n");
  process.exit(1);
}

function input(text, maximum = MAX) {
  const bytes = new TextEncoder().encode(text);
  if (!bytes.length || bytes.length > maximum) throw Error("Input limit");
  const pointer = engine.harness_input();
  if (pointer < 0 || pointer > runtime.memory.buffer.byteLength - bytes.length)
    throw Error("Input range");
  new Uint8Array(runtime.memory.buffer, pointer, bytes.length).set(bytes);
  return bytes.length;
}

function call(operation, text = "null") {
  const result = engine.harness_bridge_call(operation, input(text));
  if (result !== 0) throw Error("Guest call refused " + operation + ": " + result);
}

async function send(value) {
  if (++sentFrames > 3) throw Error("Frame budget");
  const bytes = new TextEncoder().encodeInto(encode(value), outbound.subarray(4));
  if (!bytes.written || bytes.read !== encode(value).length || bytes.written > MAX)
    throw Error("Output limit");
  outbound.writeUInt32BE(bytes.written);
  await new Promise((resolve, reject) =>
    process.stdout.write(outbound.subarray(0, bytes.written + 4), (error) =>
      error ? reject(error) : resolve(),
    ),
  );
}

async function poll() {
  call(3);
  const length = engine.harness_output_length();
  if (length > MAX) throw Error("Guest output limit");
  if (!length) return false;
  const pointer = engine.harness_output();
  if (pointer < 0 || pointer > runtime.memory.buffer.byteLength - length)
    throw Error("Output range");
  const value = parse(decode.decode(new Uint8Array(runtime.memory.buffer, pointer, length)));
  if (phase === "initializing" && value.kind === "ready") {
    if (value.id !== runtime.pluginId) throw Error("Provider mismatch");
    phase = "ready";
    await send({ protocol: PROTOCOL, kind: "ready" });
  } else if (phase === "running" && value.protocol === BROKER && value.kind === "operation") {
    await send(value);
  } else if (phase === "running" && value.kind === "result" && Object.hasOwn(value, "value")) {
    phase = "finished";
    await send({ protocol: PROTOCOL, kind: "result", value: value.value });
    engine.harness_bridge_dispose();
    process.exit(0);
  } else throw Error("Guest state refused");
  return true;
}

async function pump() {
  if (await poll()) return;
  for (;;) {
    const jobs = engine.harness_jobs();
    if (jobs < 0 || (pendingJobs += jobs) > 10000) throw Error("Job budget");
    if (await poll()) return;
    if (jobs < 32) return;
  }
}

async function receive(message) {
  if (++receivedFrames > 3 || !message || typeof message !== "object" || Array.isArray(message))
    throw Error("Frame refused");
  if (phase === "initial" && message.protocol === PROTOCOL && message.kind === "initialize") {
    if (typeof message.pluginPath !== "string" || typeof message.pluginId !== "string")
      throw Error("Invalid initialization");
    runtime = createEngine();
    engine = runtime.engine;
    runtime.pluginId = message.pluginId;
    const bridge = fs.readFileSync(path.join(__dirname, "guest-bridge.js"));
    if (
      bridge.length > 65536 ||
      crypto.createHash("sha256").update(bridge).digest("hex") !==
        "9f3c2760a5f5f9c20d2d7b14a9a078d33db2439352af4830dec16ae87c5bbb9c"
    )
      throw Error("Bridge pin refused");
    if (engine.harness_bridge_initialize(input(decode.decode(bridge), 65536)) !== 0)
      throw Error("Bridge initialization");
    const source = fs.readFileSync(message.pluginPath);
    if (source.length > 1048576) throw Error("Module source limit");
    if (engine.harness_module_load(input(decode.decode(source), 1048576)) !== 0)
      throw Error("Module loading");
    for (let jobs = 0; engine.harness_module_status() === 0;) {
      const count = engine.harness_jobs();
      if (count <= 0 || (jobs += count) > 10000) throw Error("Module job budget");
    }
    if (engine.harness_module_status() !== 1) throw Error("Module did not initialize");
    phase = "initializing";
    call(0, encode(message.configuration));
  } else if (phase === "ready" && message.protocol === PROTOCOL && message.kind === "invoke") {
    phase = "running";
    call(1, encode({ toolName: message.toolName, input: message.input }));
  } else if (phase === "running" && message.protocol === BROKER) {
    call(2, encode(message));
  } else throw Error("Unexpected frame");
  await pump();
}

process.stdin.on("data", (chunk) => {
  try {
    let offset = 0;
    while (offset < chunk.length) {
      if (!payloadLength) {
        const count = Math.min(4 - headerLength, chunk.length - offset);
        chunk.copy(header, headerLength, offset, offset + count);
        offset += count;
        headerLength += count;
        if (headerLength < 4) continue;
        payloadLength = header.readUInt32BE();
        if (!payloadLength || payloadLength > MAX) throw Error("Frame length");
      }
      const count = Math.min(payloadLength - received, chunk.length - offset);
      chunk.copy(buffer, received, offset, offset + count);
      offset += count;
      received += count;
      if (received === payloadLength) {
        if (offset !== chunk.length) throw Error("Overlapping frames");
        const message = parse(decode.decode(buffer.subarray(0, payloadLength)));
        headerLength = payloadLength = received = 0;
        process.stdin.pause();
        void receive(message).then(() => process.stdin.resume(), fail);
      }
    }
  } catch (error) {
    fail(error);
  }
});
process.stdin.on("end", fail);
process.stdin.on("error", fail);
process.stdout.on("error", () => process.exit(1));
