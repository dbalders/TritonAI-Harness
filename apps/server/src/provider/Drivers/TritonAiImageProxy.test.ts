// Real HTTP requests exercise the filter independently of Codex's wire protocol.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { limitTritonAiRequestImages, makeTritonAiImageProxy } from "./TritonAiImageProxy.ts";

const image = (id: number) => ({
  type: "input_image",
  image_url: `https://example.test/${id}.png`,
});
const screenshotHistory = {
  input: [{ role: "user", content: Array.from({ length: 9 }, (_, i) => image(i)) }],
};
const post = (url: string, body: unknown = screenshotHistory) =>
  Effect.promise(() =>
    fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer test-only", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const startProxy = Effect.fn(function* (url: string, env: NodeJS.ProcessEnv = {}) {
  const scope = yield* Scope.fork(yield* Effect.scope, "sequential");
  const baseUrl = yield* makeTritonAiImageProxy(url, env).pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  return { baseUrl, close: Scope.close(scope, Exit.void) };
});

const fixture = Effect.fn(function* (status = 200, holdOpen = false) {
  const closed = Promise.withResolvers<void>();
  const received: Array<{ url: string; headers: NodeHttp.IncomingHttpHeaders; body: unknown }> = [];
  const server = NodeHttp.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({
      url: req.url ?? "",
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.on("close", () => closed.resolve());
    res.writeHead(status, { "content-type": "text/event-stream", "x-request-id": "upstream-id" });
    res.write("data: first\n\n");
    if (!holdOpen) res.end("data: [DONE]\n\n");
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  yield* Effect.promise(
    () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
  );
  const address = server.address();
  if (!address || typeof address === "string") return yield* Effect.die("Missing test address");
  const upstream = `http://127.0.0.1:${address.port}/v1`;
  return {
    upstream,
    received,
    closed: Effect.promise(() => closed.promise),
    ...(yield* startProxy(upstream)),
  };
});

describe("TritonAI image request budget", () => {
  it("shares four image slots across attachments and tool outputs without losing text or call IDs", () => {
    const body = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "Inspect this" }, image(0)] },
        { type: "function_call_output", call_id: "first", output: [image(1)] },
        {
          type: "custom_tool_call_output",
          call_id: "second",
          output: [image(2), image(3), image(4), { type: "input_image", file_id: "latest" }],
        },
      ],
    };
    limitTritonAiRequestImages(body);
    expect(body).toEqual({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Inspect this" },
            { type: "input_text", text: expect.stringContaining("omitted") },
          ],
        },
        {
          type: "function_call_output",
          call_id: "first",
          output: [{ type: "input_text", text: expect.stringContaining("omitted") }],
        },
        {
          type: "custom_tool_call_output",
          call_id: "second",
          output: [image(2), image(3), image(4), { type: "input_image", file_id: "latest" }],
        },
      ],
    });
  });

  it("preserves requests within the budget and unrelated tool schemas", () => {
    for (const body of [
      { input: "hello" },
      {
        input: [{ content: [image(0), image(1), image(2), image(3)] }],
        tools: [{ parameters: { type: "input_image" } }],
      },
    ]) {
      const before = structuredClone(body);
      limitTritonAiRequestImages(body);
      expect(body).toEqual(before);
    }
  });

  for (const [path, status] of [
    ["responses", 200],
    ["responses/compact", 429],
  ] as const) {
    it.effect(`caps ${path} requests and preserves upstream status, headers, and streaming`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(status);
        const response = yield* post(`${f.baseUrl}/${path}`);
        expect(response.status).toBe(status);
        expect(response.headers.get("x-request-id")).toBe("upstream-id");
        expect(yield* Effect.promise(() => response.text())).toBe(
          "data: first\n\ndata: [DONE]\n\n",
        );
        expect(f.received[0]?.headers.authorization).toBe("Bearer test-only");
        expect(JSON.stringify(f.received[0]?.body).match(/input_image/g)).toHaveLength(4);
        expect(JSON.stringify(f.received[0]?.body)).not.toContain("/4.png");
        for (const id of [5, 6, 7, 8])
          expect(JSON.stringify(f.received[0]?.body)).toContain(`/${id}.png`);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("rejects unknown paths and invalid JSON before reaching upstream", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect((yield* post(new URL("/responses", f.baseUrl).href)).status).toBe(404);
      const invalid = yield* Effect.promise(() =>
        fetch(`${f.baseUrl}/responses`, { method: "POST", body: "invalid" }),
      );
      expect(invalid.status).toBe(400);
      expect(f.received).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  for (const endSession of [false, true]) {
    it.effect(
      `cancels upstream when ${endSession ? "the session ends" : "the client disconnects"}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture(200, true);
          const response = yield* post(`${f.baseUrl}/responses`);
          if (endSession) {
            const drained = response.text().catch(() => "closed");
            yield* f.close;
            yield* Effect.promise(() => drained);
            yield* Effect.promise(() => expect(fetch(`${f.baseUrl}/responses`)).rejects.toThrow());
          } else yield* Effect.promise(() => response.body!.cancel());
          yield* f.closed;
        }).pipe(Effect.scoped),
    );
  }

  for (const key of ["HTTP_PROXY", "http_proxy", "ALL_PROXY"] as const) {
    it.effect(`honors ${key} for the upstream hop`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const proxy = yield* startProxy("http://upstream.invalid/v1", {
          [key]: new URL(f.upstream).origin,
        });
        const response = yield* post(`${proxy.baseUrl}/responses`);
        expect(response.status).toBe(200);
        yield* Effect.promise(() => response.text());
        expect(f.received[0]?.url).toBe("http://upstream.invalid/v1/responses");
        expect(JSON.stringify(f.received[0]?.body).match(/input_image/g)).toHaveLength(4);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("preserves NO_PROXY and merges base query parameters with request overrides", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const proxy = yield* startProxy(`${f.upstream}?tenant=campus&api-version=config`, {
        HTTP_PROXY: "http://proxy.invalid:1234",
        NO_PROXY: "127.0.0.1",
      });
      const response = yield* post(`${proxy.baseUrl}/responses?api-version=request&trace=test`);
      expect(response.status).toBe(200);
      yield* Effect.promise(() => response.text());
      expect(f.received[0]?.url).toBe("/v1/responses?tenant=campus&api-version=request&trace=test");
    }).pipe(Effect.scoped),
  );
});
