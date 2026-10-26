// @effect-diagnostics nodeBuiltinImport:off -- Transport fakes retain the actual DNS/HTTPS boundary without contacting a provider.
import type * as NodeDns from "node:dns";
import * as NodeHttps from "node:https";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { expect, it, vi } from "vite-plus/test";
import { kualiBrokerTransport } from "./KualiBrokerTransport.ts";

const fakes = vi.hoisted(() => ({
  lookup:
    vi.fn<
      (
        host: string,
        options: { all: true; family: 4; verbatim: true },
      ) => Promise<NodeDns.LookupAddress[]>
    >(),
  request: vi.fn<typeof NodeHttps.request>(),
}));
vi.mock("node:dns/promises", () => ({ lookup: fakes.lookup }));
vi.mock("node:https", () => ({ request: fakes.request }));
function setup() {
  fakes.lookup.mockReset();
  fakes.request.mockReset();
  return fakes;
}

const input = () => ({
  credential: "synthetic-only-key",
  document: "query Fixed { apps { id } }",
  variables: {},
  signal: new AbortController().signal,
});

it("refuses every DNS answer set containing a local or special-purpose destination", async () => {
  const { lookup, request } = setup();
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "192.0.2.1",
    "224.0.0.1",
    "::1",
  ]) {
    lookup.mockResolvedValue([
      { address: "1.1.1.1", family: 4 },
      { address, family: 4 },
    ]);
    await expect(kualiBrokerTransport(input())).rejects.toThrow("public address");
  }
  expect(request).not.toHaveBeenCalled();
});

it("refuses oversized requests and credential control characters before DNS or dispatch", async () => {
  const { lookup } = setup();
  for (const override of [
    { credential: "bad\nkey" },
    { credential: "bad\u007fkey" },
    { variables: { content: "x".repeat(65_536) } },
  ]) {
    await expect(kualiBrokerTransport({ ...input(), ...override })).rejects.toThrow();
  }
  expect(lookup).not.toHaveBeenCalled();
});

function response(options: {
  status?: number;
  contentType?: string;
  encoding?: string;
  body: string;
}) {
  const value = new NodeEvents.EventEmitter() as NodeHttp.IncomingMessage;
  Object.assign(value, {
    statusCode: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "application/json",
      ...(options.encoding ? { "content-encoding": options.encoding } : {}),
    },
    destroy: (cause: Error) => {
      value.emit("error", cause);
      return value;
    },
  });
  return value;
}

it("pins HTTPS host, route, DNS and authorization independently of response or tool data", async () => {
  const { lookup, request } = setup();
  lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  request.mockImplementation((...args: Parameters<typeof NodeHttps.request>) => {
    const options = args[0] as NodeHttps.RequestOptions;
    const callback = args.find((value) => typeof value === "function") as (
      value: NodeHttp.IncomingMessage,
    ) => void;
    expect(options).toMatchObject({
      hostname: "ucsd.kualibuild.com",
      servername: "ucsd.kualibuild.com",
      port: 443,
      path: "/app/api/v0/graphql",
      method: "POST",
      rejectUnauthorized: true,
      agent: false,
      headers: { authorization: "Bearer synthetic-only-key", "accept-encoding": "identity" },
    });
    const req = new NodeEvents.EventEmitter();
    Object.assign(req, {
      end: () => {
        const res = response({ body: "" });
        callback(res);
        res.emit("data", Buffer.from('{"data":{"apps":[]}}'));
        res.emit("end");
        req.emit("close");
      },
      destroy: (cause: Error) => req.emit("error", cause),
    });
    return req as NodeHttp.ClientRequest;
  });
  await expect(kualiBrokerTransport(input())).resolves.toEqual({ apps: [] });
  expect(lookup).toHaveBeenCalledWith("ucsd.kualibuild.com", {
    all: true,
    family: 4,
    verbatim: true,
  });
});

it("does not follow redirects or confirm HTML, compressed, oversized or GraphQL-error responses", async () => {
  const { lookup, request } = setup();
  lookup.mockResolvedValue([{ address: "1.1.1.1", family: 4 }]);
  for (const options of [
    { status: 302, body: "" },
    { contentType: "text/html", body: "<p>wrong</p>" },
    { encoding: "gzip", body: "compressed" },
    { body: "x".repeat(524_289) },
    { body: '{"data":{},"errors":[{"message":"private details"}]}' },
    { body: "{}" },
  ]) {
    request.mockImplementation((...args: Parameters<typeof NodeHttps.request>) => {
      const callback = args.find((value) => typeof value === "function") as (
        value: NodeHttp.IncomingMessage,
      ) => void;
      const req = new NodeEvents.EventEmitter();
      Object.assign(req, {
        end: () => {
          const res = response(options);
          callback(res);
          res.emit("data", Buffer.from(options.body));
          res.emit("end");
          req.emit("close");
        },
        destroy: (cause: Error) => req.emit("error", cause),
      });
      return req as NodeHttp.ClientRequest;
    });
    await expect(kualiBrokerTransport(input())).rejects.toThrow();
  }
  expect(request).toHaveBeenCalledTimes(6);
});
