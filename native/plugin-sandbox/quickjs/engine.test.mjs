import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeTest from "node:test";

const bytes = await NodeFSP.readFile(new URL("./engine.wasm", import.meta.url));

NodeTest.test("oversized QuickJS function frames trap before crossing the C stack boundary", () => {
  let memory;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    wasi_snapshot_preview1: {
      fd_close: () => 8,
      fd_write: () => 8,
      fd_seek: () => 8,
      environ_get: () => 0,
      environ_sizes_get: (count, size) => {
        const view = new DataView(memory.buffer);
        view.setUint32(count, 0, true);
        view.setUint32(size, 0, true);
        return 0;
      },
      clock_time_get: (_clock, _precision, result) => {
        new DataView(memory.buffer).setBigUint64(result, 0n, true);
        return 0;
      },
    },
  });
  const engine = instance.exports;
  memory = engine.memory;
  engine.emscripten_stack_init();
  const base = engine.emscripten_stack_get_base();
  const end = engine.emscripten_stack_get_end();
  NodeAssert.equal(base - end, 262144);
  NodeAssert.equal(end, 0);
  engine.__set_stack_limits(base, end);
  engine._initialize();
  NodeAssert.equal(engine.harness_initialize(), 0);
  const evaluate = (source) => {
    const input = new TextEncoder().encode(source);
    new Uint8Array(memory.buffer, engine.harness_input(), input.length).set(input);
    return engine.harness_evaluate(input.length);
  };
  NodeAssert.equal(evaluate("1 + 1"), 0);
  NodeAssert.equal(
    new TextDecoder().decode(
      new Uint8Array(memory.buffer, engine.harness_output(), engine.harness_output_length()),
    ),
    "2",
  );
  const guard = new Uint8Array(memory.buffer, end, 64);
  guard.fill(0xa5);
  const source = `function oversized(){var ${Array.from({ length: 40000 }, (_, index) => `v${index}`).join(",")}; return 1;} oversized();`;
  NodeAssert.throws(() => evaluate(source), WebAssembly.RuntimeError);
  NodeAssert.ok(engine.emscripten_stack_get_current() >= end);
  NodeAssert.ok(engine.emscripten_stack_get_current() <= base);
  NodeAssert.ok(guard.every((byte) => byte === 0xa5));
  NodeAssert.equal(engine.harness_output_length(), 0);
});
