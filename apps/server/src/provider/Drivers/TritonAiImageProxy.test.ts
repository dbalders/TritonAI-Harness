// Exercise the loopback transport with a real HTTP client and server.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeHttp from "node:http";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { limitTritonAiRequestImages, startTritonAiImageProxy } from "./TritonAiImageProxy.ts";

const image = (index: number) => ({
  type: "input_image",
  image_url: `https://example.test/${index}.png`,
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function fixture(status = 200, holdOpen = false) {
  const upstreamClosed = Promise.withResolvers<void>();
  const received: Array<{ url: string; headers: NodeHttp.IncomingHttpHeaders; body: unknown }> = [];
  const server = NodeHttp.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({
      url: req.url ?? "",
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.on("close", () => upstreamClosed.resolve());
    res.writeHead(status, { "content-type": "text/event-stream", "x-request-id": "upstream-id" });
    res.write("data: first\n\n");
    if (!holdOpen) res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const upstreamBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  const proxy = await startTritonAiImageProxy(upstreamBaseUrl, {});
  cleanup.push(proxy.close);
  return { proxy, received, upstreamBaseUrl, upstreamClosed: upstreamClosed.promise };
}

describe("TritonAI image request budget", () => {
  it("keeps three newest screenshots across user messages and tool outputs, retaining text and call IDs", () => {
    const body = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "Inspect this" }, image(0)] },
        ...Array.from({ length: 7 }, (_, index) => ({
          type: "function_call_output",
          call_id: `call-${index}`,
          output: [image(index + 1), { type: "input_text", text: `screen-${index}` }],
        })),
      ],
    };
    limitTritonAiRequestImages(body);
    expect(JSON.stringify(body)).not.toContain("/4.png");
    for (let index = 5; index <= 7; index++)
      expect(JSON.stringify(body)).toContain(`/${index}.png`);
    for (let index = 0; index < 7; index++) {
      expect(JSON.stringify(body)).toContain(`call-${index}`);
      expect(JSON.stringify(body)).toContain(`screen-${index}`);
    }
    const first = body.input[0];
    if (!first || !("content" in first)) throw new Error("Missing user message");
    expect(first.content[0]).toEqual({ type: "input_text", text: "Inspect this" });
    expect(first.content[1]?.type).toBe("input_text");
  });

  it("bounds multiple images within a single result and file image references", () => {
    const body = {
      input: [
        {
          type: "function_call_output",
          call_id: "batch",
          output: Array.from({ length: 6 }, (_, i) => ({
            type: "input_image",
            file_id: `file-${i}`,
          })),
        },
      ],
    };
    limitTritonAiRequestImages(body);
    expect(
      body.input[0]?.output
        .filter((part) => part.type === "input_image")
        .map((part) => part.file_id),
    ).toEqual(["file-3", "file-4", "file-5"]);
  });

  it("includes custom tool images in the same request budget", () => {
    const body = {
      input: [
        { type: "custom_tool_call_output", call_id: "custom", output: [image(0), image(1)] },
        { role: "user", content: [image(2), image(3), image(4), image(5)] },
      ],
    };
    limitTritonAiRequestImages(body);
    expect(body.input[0]?.output).toEqual([
      { type: "input_text", text: expect.stringContaining("omitted") },
      { type: "input_text", text: expect.stringContaining("omitted") },
    ]);
    expect(body.input[1]?.content).toEqual([
      { type: "input_text", text: expect.stringContaining("omitted") },
      image(3),
      image(4),
      image(5),
    ]);
  });

  it("leaves requests at the limit, text-only input, and tool schemas unchanged", () => {
    for (const body of [
      { input: "hello" },
      {
        input: [{ role: "user", content: [image(0), image(1), image(2)] }],
        tools: [{ type: "function", parameters: { type: "input_image" } }],
      },
    ]) {
      const before = JSON.stringify(body);
      limitTritonAiRequestImages(body);
      expect(JSON.stringify(body)).toBe(before);
    }
  });

  for (const encoding of ["identity", "gzip", "zstd"] as const) {
    it(`caps a real ${encoding} Responses request while preserving authentication and streamed responses`, async () => {
      const { proxy, received } = await fixture();
      const serialized = JSON.stringify({
        model: "test",
        stream: true,
        input: [{ role: "user", content: Array.from({ length: 9 }, (_, i) => image(i)) }],
      });
      const body =
        encoding === "gzip"
          ? NodeZlib.gzipSync(serialized)
          : encoding === "zstd"
            ? NodeZlib.zstdCompressSync(serialized)
            : serialized;
      const response = await fetch(`${proxy.baseUrl}/responses?api-version=test`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-only",
          "content-type": "application/json",
          "content-encoding": encoding,
        },
        body,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("upstream-id");
      expect(await response.text()).toBe("data: first\n\ndata: [DONE]\n\n");
      expect(received[0]?.url).toBe("/v1/responses?api-version=test");
      expect(received[0]?.headers.authorization).toBe("Bearer test-only");
      expect(received[0]?.headers["content-encoding"]).toBeUndefined();
      expect(JSON.stringify(received[0]?.body).match(/input_image/g)).toHaveLength(3);
      expect(JSON.stringify(received[0]?.body)).toContain("/8.png");
    });
  }

  it("caps compaction requests and preserves upstream error status", async () => {
    const { proxy, received } = await fixture(429);
    const response = await fetch(`${proxy.baseUrl}/responses/compact`, {
      method: "POST",
      body: JSON.stringify({ input: [{ content: Array.from({ length: 5 }, (_, i) => image(i)) }] }),
    });
    expect(response.status).toBe(429);
    await response.text();
    expect(JSON.stringify(received[0]?.body).match(/input_image/g)).toHaveLength(3);
  });

  it("rejects unknown local paths and malformed JSON without contacting upstream", async () => {
    const { proxy, received } = await fixture();
    const denied = await fetch(new URL("/responses", proxy.baseUrl), {
      method: "POST",
      body: "{}",
    });
    expect(denied.status).toBe(404);
    const invalid = await fetch(`${proxy.baseUrl}/responses`, { method: "POST", body: "invalid" });
    expect(invalid.status).toBe(400);
    expect(received).toHaveLength(0);
  });
  it("cancels upstream streaming when the client disconnects", async () => {
    const { proxy, upstreamClosed } = await fixture(200, true);
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      body: '{"input":"hello"}',
    });
    await response.body?.cancel();
    await upstreamClosed;
  });

  it("closes active upstream requests and the listener when the session ends", async () => {
    const { proxy, upstreamClosed } = await fixture(200, true);
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      body: '{"input":"hello"}',
    });
    const drained = response.text().catch(() => "closed");
    await proxy.close();
    await upstreamClosed;
    await drained;
    await expect(fetch(`${proxy.baseUrl}/responses`)).rejects.toThrow();
  });
  for (const proxyKey of ["HTTP_PROXY", "http_proxy", "ALL_PROXY"] as const) {
    it(`preserves ${proxyKey} routing on the upstream hop`, async () => {
      const { upstreamBaseUrl, received } = await fixture();
      const proxy = await startTritonAiImageProxy("http://upstream.invalid/v1", {
        [proxyKey]: new URL(upstreamBaseUrl).origin,
      });
      cleanup.push(proxy.close);
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: "Bearer test-only" },
        body: JSON.stringify({ input: [{ content: [image(0), image(1), image(2), image(3)] }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(received[0]?.url).toBe("http://upstream.invalid/v1/responses");
      expect(received[0]?.headers.authorization).toBe("Bearer test-only");
      expect(JSON.stringify(received[0]?.body).match(/input_image/g)).toHaveLength(3);
    });
  }

  it("respects NO_PROXY for the configured upstream", async () => {
    const { upstreamBaseUrl, received } = await fixture();
    const proxy = await startTritonAiImageProxy(upstreamBaseUrl, {
      HTTP_PROXY: "http://proxy.invalid:1234",
      NO_PROXY: "127.0.0.1",
    });
    cleanup.push(proxy.close);
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      body: '{"input":"hello"}',
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(received[0]?.url).toBe("/v1/responses");
  });
});
