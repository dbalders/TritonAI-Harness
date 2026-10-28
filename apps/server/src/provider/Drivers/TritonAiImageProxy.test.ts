// Real HTTP requests exercise the filter independently of Codex's wire protocol.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  limitTritonAiRequestImages,
  makeTritonAiImageProxy,
  toCodexToolSearchEvent,
  translateToolSearchForGateway,
  type TritonAiImageProxyOptions,
} from "./TritonAiImageProxy.ts";

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
      headers: {
        authorization: "Bearer test-only",
        "content-type": "application/json",
        "x-litellm-tags": "app:tritonai-harness,version:test,purpose:chat",
        "x-litellm-end-user-id": "harness-install:0b3f1d9e-5c2a-4e7b-9a41-2f6c8d0e7a15",
      },
      body: JSON.stringify(body),
    }),
  );

const startProxy = Effect.fn(function* (
  url: string,
  env: NodeJS.ProcessEnv = {},
  options: TritonAiImageProxyOptions = {},
) {
  const scope = yield* Scope.fork(yield* Effect.scope, "sequential");
  const baseUrl = yield* makeTritonAiImageProxy(url, env, options).pipe(
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

// regression: #257 fix(codex): cap computer-use requests at four images
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

  describe.each(
    Array.from(
      [
        ["responses", 200],
        ["responses/compact", 429],
      ] as const,
      (scenario) => ({ scenario }),
    ),
  )("case $scenario", ({ scenario: [path, status] }) => {
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
        expect(f.received[0]?.headers["x-litellm-tags"]).toBe(
          "app:tritonai-harness,version:test,purpose:chat",
        );
        expect(f.received[0]?.headers["x-litellm-end-user-id"]).toBe(
          "harness-install:0b3f1d9e-5c2a-4e7b-9a41-2f6c8d0e7a15",
        );
        expect(JSON.stringify(f.received[0]?.body).match(/input_image/g)).toHaveLength(4);
        expect(JSON.stringify(f.received[0]?.body)).not.toContain("/4.png");
        for (const id of [5, 6, 7, 8])
          expect(JSON.stringify(f.received[0]?.body)).toContain(`/${id}.png`);
      }).pipe(Effect.scoped),
    );
  });

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

  describe.each(Array.from([false, true], (scenario) => ({ scenario })))(
    "case $scenario",
    ({ scenario: endSession }) => {
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
              yield* Effect.promise(() =>
                expect(fetch(`${f.baseUrl}/responses`)).rejects.toThrow(),
              );
            } else yield* Effect.promise(() => response.body!.cancel());
            yield* f.closed;
          }).pipe(Effect.scoped),
      );
    },
  );

  describe.each(Array.from(["HTTP_PROXY", "ALL_PROXY"] as const, (scenario) => ({ scenario })))(
    "case $scenario",
    ({ scenario: key }) => {
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
    },
  );

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

const message = (role: string, text: string) => ({
  type: "message",
  role,
  content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
});
const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

// A gateway that answers every request with the same server-sent events.
const scriptedGateway = Effect.fn(function* (
  events: ReadonlyArray<string>,
  options: TritonAiImageProxyOptions,
) {
  const received: any[] = [];
  const receivedHeaders: NodeHttp.IncomingHttpHeaders[] = [];
  const server = NodeHttp.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(parts).toString()));
    receivedHeaders.push(req.headers);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) res.write(event);
    res.end();
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
  return {
    received,
    receivedHeaders,
    ...(yield* startProxy(`http://127.0.0.1:${address.port}/v1`, {}, options)),
  };
});

// Codex 0.161's client-side tool search, as sent for hosted models with deferred plugin tools.
const toolSearchTool = {
  type: "tool_search",
  execution: "client",
  description: "# Tool discovery",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const mailSearch = {
  type: "function",
  name: "microsoft365_mail_search",
  description: "Search Outlook mail.",
  strict: false,
  defer_loading: true,
  parameters: { type: "object", properties: { query: { type: "string" } } },
};
const { defer_loading: _deferLoading, ...mailSearchWithoutDeferral } = mailSearch;
const searchedThread = () => ({
  model: "api-glm-5.3-flash",
  stream: true,
  tools: [
    { type: "function", name: "exec_command", parameters: {} },
    toolSearchTool,
    { type: "namespace", name: "microsoft365", tools: [{ type: "function", name: "existing" }] },
  ],
  input: [
    message("user", "Find my invoice email."),
    {
      type: "tool_search_call",
      call_id: "call_search",
      status: "completed",
      execution: "client",
      arguments: { query: "outlook mail", limit: 8 },
    },
    {
      type: "tool_search_output",
      call_id: "call_search",
      status: "completed",
      execution: "client",
      tools: [{ type: "namespace", name: "microsoft365", description: "", tools: [mailSearch] }],
    },
    {
      type: "function_call",
      call_id: "call_mail",
      namespace: "microsoft365",
      name: "microsoft365_mail_search",
      arguments: '{"query":"invoice"}',
    },
    { type: "function_call_output", call_id: "call_mail", output: "[]" },
  ],
});

describe("TritonAI tool search translation", () => {
  it("sends search as an ordinary function and makes found tools callable", () => {
    const body = searchedThread();
    expect(translateToolSearchForGateway(body)).toBe(true);
    expect(body.tools).toEqual([
      { type: "function", name: "exec_command", parameters: {} },
      {
        type: "function",
        name: "tool_search",
        description: "# Tool discovery",
        strict: false,
        parameters: toolSearchTool.parameters,
      },
      {
        type: "namespace",
        name: "microsoft365",
        tools: [{ type: "function", name: "existing" }, mailSearchWithoutDeferral],
      },
    ]);
    expect(body.input.slice(1, 3)).toEqual([
      {
        type: "function_call",
        call_id: "call_search",
        name: "tool_search",
        arguments: '{"query":"outlook mail","limit":8}',
      },
      {
        type: "function_call_output",
        call_id: "call_search",
        output: "These tools are now available to call: microsoft365_mail_search.",
      },
    ]);
    // Namespaced calls already work through the gateway and stay as Codex sent them.
    expect(body.input.slice(3)).toEqual(searchedThread().input.slice(3));
    // Translating again is harmless and does not duplicate found tools.
    expect(translateToolSearchForGateway(body)).toBe(false);
    expect(JSON.stringify(body.tools).match(/microsoft365_mail_search/g)).toHaveLength(1);
  });

  it("reports an empty search and leaves requests without search unchanged", () => {
    const empty = {
      tools: [toolSearchTool],
      input: [
        {
          type: "tool_search_output",
          call_id: "c",
          status: "completed",
          execution: "client",
          tools: [],
        },
      ],
    };
    expect(translateToolSearchForGateway(empty)).toBe(true);
    expect(empty.input[0]).toEqual({
      type: "function_call_output",
      call_id: "c",
      output: "No matching tools were found.",
    });
    // Compaction sends the history without tools: replay it, but add no tools for the summary.
    const compaction = { ...searchedThread(), tools: [] };
    expect(translateToolSearchForGateway(compaction)).toBe(false);
    expect(compaction.tools).toEqual([]);
    expect(JSON.stringify(compaction.input)).not.toContain("tool_search_");
    const plain = { tools: [{ type: "function", name: "x" }], input: [message("user", "hi")] };
    const before = structuredClone(plain);
    expect(translateToolSearchForGateway(plain)).toBe(false);
    expect(plain).toEqual(before);
  });

  it("returns the gateway's search call to Codex as its client-side search", () => {
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      status: "completed",
      name: "tool_search",
      arguments: '{"query":"outlook mail","limit":3}',
    };
    const expected = {
      type: "tool_search_call",
      id: "fc_1",
      call_id: "call_1",
      status: "completed",
      execution: "client",
      arguments: { query: "outlook mail", limit: 3 },
    };
    const done = JSON.parse(
      toCodexToolSearchEvent(JSON.stringify({ type: "response.output_item.done", item: call })),
    );
    expect(done).toEqual({ type: "response.output_item.done", item: expected });
    const added = JSON.parse(
      toCodexToolSearchEvent(
        JSON.stringify({
          type: "response.output_item.added",
          item: { ...call, status: "in_progress", arguments: "" },
        }),
      ),
    );
    expect(added.item).toMatchObject({ type: "tool_search_call", arguments: {} });
    // Ordinary and namespaced calls are untouched.
    for (const unchanged of [
      JSON.stringify({
        type: "response.output_item.done",
        item: { ...call, name: "exec_command" },
      }),
      JSON.stringify({ type: "response.output_item.done", item: { ...call, namespace: "x" } }),
      "[DONE]",
    ])
      expect(toCodexToolSearchEvent(unchanged)).toBe(unchanged);
  });

  it.effect("translates search both ways only for models that need it", () =>
    Effect.gen(function* () {
      const searchCall = {
        type: "function_call",
        call_id: "call_1",
        status: "completed",
        name: "tool_search",
        arguments: '{"query":"mail"}',
      };
      const events = [
        sse({ type: "response.output_item.done", item: searchCall }),
        sse({ type: "response.completed", response: { output: [] } }),
      ];
      const gateway = yield* scriptedGateway(events, {
        translateToolSearch: (model) => model === "api-glm-5.3-flash",
      });
      const hosted = yield* post(`${gateway.baseUrl}/responses`, searchedThread());
      const hostedText = yield* Effect.promise(() => hosted.text());
      expect(hostedText).toContain('"type":"tool_search_call"');
      expect(hostedText).not.toContain('"name":"tool_search"');
      expect(JSON.stringify(gateway.received[0])).not.toContain("tool_search_call");
      expect(JSON.stringify(gateway.received[0].tools)).toContain("microsoft365_mail_search");
      // The rewritten reply is read as text, so it must not come back compressed.
      expect(gateway.receivedHeaders[0]?.["accept-encoding"]).toBeUndefined();

      const native = yield* post(`${gateway.baseUrl}/responses`, {
        ...searchedThread(),
        model: "gpt-6.1-sol",
      });
      expect(yield* Effect.promise(() => native.text())).toBe(events.join(""));
      expect(gateway.received[1]).toEqual({ ...searchedThread(), model: "gpt-6.1-sol" });
    }).pipe(Effect.scoped),
  );
});
