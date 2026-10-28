// Real HTTP requests exercise the filter independently of Codex's wire protocol.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  acceptOutputLimitedEvent,
  makeResponseEventRewriter,
  boundTritonAiReplayedModelOutput,
  capTritonAiOutputTokens,
  limitTritonAiRequestImages,
  makeTritonAiGatewayProxy,
  MAX_REPLAYED_MODEL_TEXT_CHARS,
  rewriteResponseEvents,
  TRITONAI_MAX_OUTPUT_TOKENS,
  trimTritonAiRequestHistory,
  type TritonAiGatewayProxyOptions,
} from "./TritonAiGatewayProxy.ts";
import * as Stream from "effect/Stream";

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
  options: TritonAiGatewayProxyOptions = {},
) {
  const scope = yield* Scope.fork(yield* Effect.scope, "sequential");
  const baseUrl = yield* makeTritonAiGatewayProxy(url, env, options).pipe(
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

// A gateway that answers each request with a fixed status, content type, and body.
type Reply = { status: number; contentType: string; chunks: ReadonlyArray<string> };
const scriptedGateway = Effect.fn(function* (
  status: number | ((body: any) => Reply),
  contentType = "",
  fixedChunks: ReadonlyArray<string> = [],
  options: TritonAiGatewayProxyOptions = {},
) {
  const received: any[] = [];
  const server = NodeHttp.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(parts).toString());
    received.push(body);
    const reply =
      typeof status === "function" ? status(body) : { status, contentType, chunks: fixedChunks };
    const chunks = reply.chunks;
    res.writeHead(reply.status, {
      "content-type": reply.contentType,
      "x-request-id": "upstream-id",
    });
    for (const chunk of chunks) res.write(chunk);
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
  return { received, ...(yield* startProxy(`http://127.0.0.1:${address.port}/v1`, {}, options)) };
});

// The gateway's HTTP 400 body when a request exceeds GLM 5.3 Flash's window, captured on
// 2026-10-27. Only the gateway's internal fallback routing list is left out.
const litellmOverflow = JSON.stringify({
  error: {
    message:
      'litellm.ContextWindowExceededError: litellm.BadRequestError: ContextWindowExceededError: Hosted_vllmException - {"error":{"message":"This model\'s maximum context length is 524288 tokens. However, your prompt contains at least 524289 input tokens, which exceeds this limit even without any output tokens. Please reduce the length of the input prompt. (parameter=input_tokens, value=524289)","type":"BadRequestError","param":"input_tokens","code":400}}\nmodel=api-glm-5.3-flash. context_window_fallbacks=None. fallbacks=[omitted].\n\nSet \'context_window_fallback\' - https://docs.litellm.ai/docs/routing#fallbacks',
    type: "invalid_request_error",
    param: null,
    code: "400",
  },
});

const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const outputLimited = (output: unknown[]) => ({
  type: "response.incomplete",
  response: {
    id: "resp_1",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output,
    usage: { input_tokens: 10, output_tokens: 32_768 },
  },
});
const cutOffCall = {
  type: "function_call",
  status: "incomplete",
  name: "exec_command",
  call_id: "call_1",
  arguments: '{"cmd": "python3 - <<EOF\\nB64 = \\"UEsDBBQABgAI',
};

describe("TritonAI context window guard", () => {
  it("shortens oversized model-written history while keeping arguments valid JSON", () => {
    const runaway = `{"cmd": "python3 <<EOF\\nB64 = \\"${"A".repeat(2_850_000)}`;
    const longScript = JSON.stringify({ cmd: `cat > notes.md <<EOF\n${"x".repeat(90_000)}\nEOF` });
    const longText = "y".repeat(120_000);
    const toolOutput = { type: "function_call_output", call_id: "c", output: "z".repeat(60_000) };
    const user = { role: "user", content: [{ type: "input_text", text: "u".repeat(60_000) }] };
    const small = { type: "function_call", call_id: "s", name: "exec_command", arguments: "{}" };
    const body = {
      input: [
        user,
        small,
        { type: "function_call", call_id: "a", name: "exec_command", arguments: runaway },
        { type: "function_call", call_id: "b", name: "exec_command", arguments: longScript },
        { type: "custom_tool_call", call_id: "p", name: "apply_patch", input: longText },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: longText }],
          content: [{ type: "reasoning_text", text: longText }],
        },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: longText }] },
        toolOutput,
      ],
    };
    const before = structuredClone(body);
    boundTritonAiReplayedModelOutput(body);
    const [keptUser, keptSmall, runawayCall, scriptCall, patch, reasoning, assistant, output] =
      body.input as any[];
    expect(keptUser).toEqual(before.input[0]);
    expect(keptSmall).toEqual(small);
    expect(output).toEqual(toolOutput);
    const runawayArgs = JSON.parse(runawayCall.arguments);
    expect(runawayArgs.note).toContain("smaller pieces");
    expect(runawayCall.arguments.length).toBeLessThan(5_000);
    expect(JSON.parse(scriptCall.arguments).cmd).toMatch(
      /^cat > notes\.md[\s\S]*left out[\s\S]*EOF$/,
    );
    for (const text of [
      patch.input,
      reasoning.summary[0].text,
      reasoning.content[0].text,
      assistant.content[0].text,
    ]) {
      expect(text.length).toBeLessThan(MAX_REPLAYED_MODEL_TEXT_CHARS + 300);
      expect(text).toContain("left out");
    }
    // Deterministic, so the gateway's prompt cache still matches on the next request.
    const again = structuredClone(before);
    boundTritonAiReplayedModelOutput(again);
    expect(again).toEqual(body);
  });

  it("adds an output limit only for capped models without one", () => {
    const body: Record<string, unknown> = { model: "api-glm-5.3-flash" };
    capTritonAiOutputTokens(body, 32_768);
    expect(body.max_output_tokens).toBe(32_768);
    const own = { max_output_tokens: 2_500 };
    capTritonAiOutputTokens(own, 32_768);
    expect(own.max_output_tokens).toBe(2_500);
    const frontier: Record<string, unknown> = {};
    capTritonAiOutputTokens(frontier, undefined);
    expect(frontier).toEqual({});
  });

  it("accepts an output-limited reply only after Codex received a tool call or message", () => {
    const limited = JSON.stringify(outputLimited([{ type: "reasoning" }, cutOffCall]));
    const accepted = JSON.parse(acceptOutputLimitedEvent(limited, true));
    expect(accepted.type).toBe("response.completed");
    expect(accepted.response.status).toBe("completed");
    expect(accepted.response.output[1]).toEqual(cutOffCall);
    // A call present only in the final snapshot never reached Codex, so keep its retry.
    expect(acceptOutputLimitedEvent(limited, false)).toBe(limited);
    for (const unchanged of [
      JSON.stringify({
        ...outputLimited([cutOffCall]),
        response: {
          ...outputLimited([]).response,
          incomplete_details: { reason: "content_filter" },
        },
      }),
      JSON.stringify({ type: "response.completed", response: { output: [] } }),
      "[DONE]",
    ])
      expect(acceptOutputLimitedEvent(unchanged, true)).toBe(unchanged);
  });

  it("tracks delivered items per stream", () => {
    const limited = JSON.stringify(outputLimited([{ type: "reasoning" }, cutOffCall]));
    const reasoningOnly = makeResponseEventRewriter();
    reasoningOnly(
      JSON.stringify({ type: "response.output_item.done", item: { type: "reasoning" } }),
    );
    expect(reasoningOnly(limited)).toBe(limited);
    const withCall = makeResponseEventRewriter();
    withCall(JSON.stringify({ type: "response.output_item.done", item: cutOffCall }));
    expect(JSON.parse(withCall(limited)).type).toBe("response.completed");
    // A fresh stream starts without delivered items.
    expect(makeResponseEventRewriter()(limited)).toBe(limited);
  });

  it.effect("rewrites events split across chunks without changing other bytes", () =>
    Effect.gen(function* () {
      const done = sse({ type: "response.output_item.done", item: cutOffCall });
      const original = `event: response.created\ndata: {"type":"response.created"}\n\n${done}${sse(
        outputLimited([cutOffCall]),
      )}data: [DONE]\n\n`;
      const encoder = new TextEncoder();
      const chunks = [
        original.slice(0, 7),
        original.slice(7, 61),
        original.slice(61, 200),
        original.slice(200, 420),
        original.slice(420),
      ];
      const text = yield* rewriteResponseEvents(
        Stream.fromIterable(chunks.map((chunk) => encoder.encode(chunk))),
      ).pipe(Stream.decodeText, Stream.mkString);
      expect(text).toBe(
        original.replace(
          sse(outputLimited([cutOffCall])),
          sse(
            JSON.parse(acceptOutputLimitedEvent(JSON.stringify(outputLimited([cutOffCall])), true)),
          ),
        ),
      );
      const plain = "data: one\n\ndata: [DONE]\n\n";
      expect(
        yield* rewriteResponseEvents(Stream.make(encoder.encode(plain))).pipe(
          Stream.decodeText,
          Stream.mkString,
        ),
      ).toBe(plain);
    }),
  );

  it.effect(
    "reports the gateway's context overflow as a streamed failure Codex can recover from",
    () =>
      Effect.gen(function* () {
        const gateway = yield* scriptedGateway(400, "application/json", [litellmOverflow]);
        const response = yield* post(`${gateway.baseUrl}/responses`, {
          model: "m",
          stream: true,
          input: [],
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(response.headers.get("x-request-id")).toBe("upstream-id");
        const [line] = (yield* Effect.promise(() => response.text())).trim().split("\n");
        const event = JSON.parse(line!.slice("data: ".length));
        expect(event.type).toBe("response.failed");
        expect(event.response.error.code).toBe("context_length_exceeded");
        expect(JSON.stringify(event)).not.toContain("litellm");
      }).pipe(Effect.scoped),
  );

  it.effect("passes other gateway errors and non-streaming overflow through unchanged", () =>
    Effect.gen(function* () {
      const other = JSON.stringify({ error: { message: "Invalid structural tag", code: "400" } });
      for (const [body, request] of [
        [other, { stream: true, input: [] }],
        [litellmOverflow, { stream: false, input: [] }],
      ] as const) {
        const gateway = yield* scriptedGateway(400, "application/json", [body]);
        const response = yield* post(`${gateway.baseUrl}/responses`, request);
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(yield* Effect.promise(() => response.text())).toBe(body);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("caps hosted-model output and accepts an output-limited tool call end to end", () =>
    Effect.gen(function* () {
      // The gateway's order for a cut-off tool call (observed 2026-10-27).
      const events = [
        sse({ type: "response.created" }),
        sse({ type: "response.output_item.done", item: cutOffCall }),
        sse(outputLimited([cutOffCall])),
        "data: [DONE]\n\n",
      ];
      const gateway = yield* scriptedGateway(200, "text/event-stream", events, {
        outputTokenLimit: (model) => (model === "api-glm-5.3-flash" ? 32_768 : undefined),
      });
      const hosted = yield* post(`${gateway.baseUrl}/responses`, {
        model: "api-glm-5.3-flash",
        stream: true,
        input: [],
      });
      const text = yield* Effect.promise(() => hosted.text());
      expect(text).toContain('"type":"response.completed"');
      expect(text).not.toContain("response.incomplete");
      const frontier = yield* post(`${gateway.baseUrl}/responses`, {
        model: "gpt-6.1-sol",
        stream: true,
        input: [],
      });
      yield* Effect.promise(() => frontier.text());
      expect(gateway.received).toMatchObject([
        { model: "api-glm-5.3-flash", max_output_tokens: 32_768 },
        { model: "gpt-6.1-sol" },
      ]);
      expect(gateway.received[1]).not.toHaveProperty("max_output_tokens");
    }).pipe(Effect.scoped),
  );
});

const message = (role: string, text: string) => ({
  type: "message",
  role,
  content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
});
const call = (id: string, size = 1_000) => [
  {
    type: "function_call",
    call_id: id,
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "x".repeat(size) }),
  },
  { type: "function_call_output", call_id: id, output: "o".repeat(size) },
];
// Opening context, two earlier turns of tool work, then the active turn.
const longThread = () => ({
  model: "api-glm-5.3-flash",
  stream: true,
  input: [
    message("developer", "permissions"),
    message("user", "<environment_context>cwd</environment_context>"),
    message("user", "first request"),
    message("assistant", "working"),
    ...call("a"),
    ...call("b"),
    message("user", "second request"),
    message("developer", "<runtime_info>model</runtime_info>"),
    ...call("c"),
    ...call("d"),
    ...call("e"),
    message("assistant", "still working"),
    ...call("f"),
  ],
});
const callIds = (input: any[], type: string) =>
  input.filter((item) => item.type === type).map((item) => item.call_id);

describe("TritonAI overflow recovery", () => {
  it("leaves out the oldest history in whole tool-call pairs and keeps what the model needs", () => {
    const body = longThread();
    expect(trimTritonAiRequestHistory(body, 0.35)).toBe(true);
    const texts = () => body.input.map((item: any) => item.content?.[0]?.text).filter(Boolean);
    expect(texts().slice(0, 2)).toEqual([
      "permissions",
      "<environment_context>cwd</environment_context>",
    ]);
    // The first request is ordinary history; the latest request and instructions stay.
    expect(texts()[2]).toMatch(/left out 6 earlier conversation items/);
    expect(texts()).toContain("second request");
    expect(texts()).toContain("<runtime_info>model</runtime_info>");
    expect(texts()).not.toContain("first request");
    // Every remaining call still has its output.
    expect(callIds(body.input, "function_call")).toEqual(
      callIds(body.input, "function_call_output"),
    );
    expect(callIds(body.input, "function_call")).toEqual(["c", "d", "e", "f"]);

    // A second pass replaces the notice and keeps a running count.
    expect(trimTritonAiRequestHistory(body, 1)).toBe(true);
    expect(texts().filter((text: string) => text.includes("left out"))).toEqual([
      expect.stringMatching(/left out 10 earlier/),
    ]);
    // Call "e" stays because its output is among the protected recent items.
    expect(callIds(body.input, "function_call")).toEqual(["e", "f"]);
    expect(body.input.at(-1)).toEqual(longThread().input.at(-1));

    // Only protected items remain, so there is nothing left to trim.
    const settled = structuredClone(body);
    expect(trimTritonAiRequestHistory(body, 1)).toBe(false);
    expect(body).toEqual(settled);
    expect(trimTritonAiRequestHistory({ input: [message("user", "only")] }, 1)).toBe(false);
  });

  // regression: in the desktop app, earlier turns that failed left only large user messages.
  it("can leave out every earlier turn, including recent unanswered messages", () => {
    const body = {
      input: [
        message("developer", "<skills_instructions>"),
        message("user", "<environment_context>cwd</environment_context>"),
        ...[1, 2, 3, 4, 5, 6].map((n) => message("user", `part ${n} ${"w ".repeat(5_000)}`)),
      ],
    };
    expect(trimTritonAiRequestHistory(body, 1)).toBe(true);
    expect(body.input.map((item: any) => item.content[0].text.slice(0, 30))).toEqual([
      "<skills_instructions>",
      "<environment_context>cwd</envi",
      "[TritonAI Harness left out 5 e",
      "part 6 w w w w w w w w w w w w",
    ]);
  });

  it("leaves out older copies of resent instruction blocks but keeps the newest", () => {
    const body = {
      input: [
        message("developer", "<t3_code_runtime>old</t3_code_runtime>"),
        message("developer", "permissions"),
        message("user", "first"),
        message("assistant", "ok"),
        message("developer", "<t3_code_runtime>new</t3_code_runtime>"),
        message("user", "latest"),
      ],
    };
    expect(trimTritonAiRequestHistory(body, 1)).toBe(true);
    expect(body.input.map((item: any) => item.content[0].text.slice(0, 26))).toEqual([
      "[TritonAI Harness left out",
      "permissions",
      "<t3_code_runtime>new</t3_c",
      "latest",
    ]);
  });

  it.effect("retries with less history until the gateway accepts, then streams normally", () =>
    Effect.gen(function* () {
      const ok = [
        sse({ type: "response.created" }),
        sse({
          type: "response.completed",
          response: { output: [], usage: { input_tokens: 500_000 } },
        }),
      ];
      // Simulates a model window that fits only after most early tool work is gone.
      const gateway = yield* scriptedGateway((body) =>
        JSON.stringify(body).length > 8_000
          ? { status: 400, contentType: "application/json", chunks: [litellmOverflow] }
          : { status: 200, contentType: "text/event-stream", chunks: ok },
      );
      const response = yield* post(`${gateway.baseUrl}/responses`, longThread());
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe(ok.join(""));
      expect(gateway.received).toHaveLength(3);
      const sizes = gateway.received.map((body) => JSON.stringify(body).length);
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
      const accepted = gateway.received.at(-1);
      expect(callIds(accepted.input, "function_call")).toEqual(
        callIds(accepted.input, "function_call_output"),
      );
      expect(JSON.stringify(accepted)).toContain("earlier conversation items");
    }).pipe(Effect.scoped),
  );

  // Codex compacts on this route by sending its history plus a summary prompt to /responses.
  // Without the proxy, Codex retries the gateway's 400 five times and the thread stays stuck.
  const instructions = [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "<environment>" }] },
  ];
  const userText = (text: string) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
  const summaryReply = [
    sse({ type: "response.created" }),
    sse({
      type: "response.output_item.done",
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "S" }] },
    }),
    sse({ type: "response.completed", response: { output: [], usage: { input_tokens: 9 } } }),
  ];
  const gatewayWindow = (limit: number) => (body: unknown) =>
    JSON.stringify(body).length > limit
      ? { status: 400, contentType: "application/json", chunks: [litellmOverflow] }
      : { status: 200, contentType: "text/event-stream", chunks: summaryReply };

  it.effect("lets Codex compact a thread the gateway rejected as too long", () =>
    Effect.gen(function* () {
      const compactionPrompt = "You are performing a CONTEXT CHECKPOINT COMPACTION.";
      const thread = {
        model: "api-glm-5.3-flash",
        stream: true,
        input: [
          ...instructions,
          userText(`Review this packet:\n${"clause ".repeat(60_000)}`),
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
          ...instructions,
          userText("Continue."),
          userText(compactionPrompt),
        ],
      };
      const gateway = yield* scriptedGateway(gatewayWindow(100_000));
      const response = yield* post(`${gateway.baseUrl}/responses`, thread);
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe(summaryReply.join(""));
      expect(gateway.received.length).toBeGreaterThan(1);
      const accepted = gateway.received.at(-1).input;
      expect(JSON.stringify(accepted)).not.toContain("clause clause");
      expect(accepted.at(-1).content[0].text).toBe(compactionPrompt);
      expect(accepted.at(-2).content[0].text).toBe("Continue.");
    }).pipe(Effect.scoped),
  );

  it.effect("sends a looping reasoning reply back short enough for the next request", () =>
    Effect.gen(function* () {
      // A 2026-10-27 GLM 5.3 Flash reply reasoned "maybe" 341,000 times for 18 minutes.
      const thread = {
        model: "api-glm-5.3-flash",
        stream: true,
        input: [
          ...instructions,
          userText("Continue."),
          {
            type: "reasoning",
            summary: [],
            content: [{ type: "reasoning_text", text: "maybe ".repeat(341_474) }],
          },
          userText("Are you still there?"),
        ],
      };
      const gateway = yield* scriptedGateway(gatewayWindow(100_000), "", [], {
        outputTokenLimit: () => TRITONAI_MAX_OUTPUT_TOKENS,
      });
      const response = yield* post(`${gateway.baseUrl}/responses`, thread);
      expect(response.status).toBe(200);
      yield* Effect.promise(() => response.text());
      expect(gateway.received).toHaveLength(1);
      expect(gateway.received[0].max_output_tokens).toBe(TRITONAI_MAX_OUTPUT_TOKENS);
    }).pipe(Effect.scoped),
  );

  it.effect("reports the overflow once trimming cannot make the request fit", () =>
    Effect.gen(function* () {
      const gateway = yield* scriptedGateway(400, "application/json", [litellmOverflow]);
      const response = yield* post(`${gateway.baseUrl}/responses`, longThread());
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toContain("context_length_exceeded");
      // The first attempt plus one per trim step, each smaller than the last.
      expect(gateway.received).toHaveLength(1 + 2);
    }).pipe(Effect.scoped),
  );
});
