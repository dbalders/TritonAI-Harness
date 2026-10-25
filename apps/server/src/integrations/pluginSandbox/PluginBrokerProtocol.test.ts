import { expect, it } from "vite-plus/test";
import {
  decodePluginBrokerOperation,
  encodePluginBrokerFrame,
  MAX_PLUGIN_BROKER_FRAME_BYTES,
  PluginBrokerFrameDecoder,
  PLUGIN_BROKER_PROTOCOL,
} from "./PluginBrokerProtocol.ts";

const operation = {
  protocol: PLUGIN_BROKER_PROTOCOL,
  requestId: 1,
  kind: "operation",
  operationId: "synthetic.items.put.v1",
  parameters: { id: "one", content: "synthetic" },
} as const;

it("decodes split pipe headers and multibyte JSON without repeated buffer growth", () => {
  const decoder = new PluginBrokerFrameDecoder();
  const frame = encodePluginBrokerFrame({ ...operation, parameters: { content: "π🙂" } });
  const messages = [...frame].flatMap((byte) => decoder.push(new Uint8Array([byte])));
  expect(messages).toEqual([{ ...operation, parameters: { content: "π🙂" } }]);
  decoder.end();
});

it("admits a body only after its bounded length header", () => {
  for (const size of [0, MAX_PLUGIN_BROKER_FRAME_BYTES + 1, 0xffff_ffff]) {
    const decoder = new PluginBrokerFrameDecoder();
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, size);
    expect(() => decoder.push(header)).toThrow("byte limit");
    expect(() => decoder.push(encodePluginBrokerFrame(operation))).toThrow("closed");
  }
});

it("rejects malformed UTF-8 and pipe truncation instead of repairing worker data", () => {
  const invalid = new Uint8Array([0, 0, 0, 2, 0xc3, 0x28]);
  expect(() => new PluginBrokerFrameDecoder().push(invalid)).toThrow();
  const decoder = new PluginBrokerFrameDecoder();
  decoder.push(encodePluginBrokerFrame(operation).subarray(0, 5));
  expect(() => decoder.end()).toThrow("during a frame");
});

it("caps JSON depth and the number of messages delivered from one pipe chunk", () => {
  const nested = `${"[".repeat(34)}0${"]".repeat(34)}`;
  const body = new TextEncoder().encode(nested);
  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, 4);
  expect(() => new PluginBrokerFrameDecoder().push(frame)).toThrow("depth limit");
  const single = encodePluginBrokerFrame(null);
  const burst = new Uint8Array(single.length * 17);
  for (let i = 0; i < 17; i++) burst.set(single, i * single.length);
  expect(() => new PluginBrokerFrameDecoder().push(burst)).toThrow("burst");
});

it("accepts only the broker ABI operation keys and numeric request range", () => {
  expect(decodePluginBrokerOperation(operation)).toEqual(operation);
  for (const invalid of [
    { ...operation, connectionId: "another-connection" },
    { ...operation, url: "https://example.invalid" },
    { ...operation, requestId: "1" },
    { ...operation, requestId: 2_147_483_648 },
    { ...operation, parameters: [] },
    { ...operation, operationId: "synthetic..put" },
  ])
    expect(() => decodePluginBrokerOperation(invalid)).toThrow();
});
