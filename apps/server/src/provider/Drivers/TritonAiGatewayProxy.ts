// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { EnvHttpProxyAgent } from "@effect/platform-node/Undici";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import {
  Headers,
  HttpBody,
  HttpClientRequest,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

// Match the gateway's four-image limit.
const MAX_IMAGES = 4;
const OMITTED_IMAGE =
  "[Earlier image omitted from this request; use the latest screenshots below.]";

/** Bound model-visible images without changing the stored transcript or tool-call pairing. */
export function limitTritonAiRequestImages(body: unknown): void {
  if (!Predicate.isObject(body) || !Array.isArray(body.input)) return;
  const images: Array<{ parts: unknown[]; index: number }> = [];
  for (const item of body.input) {
    if (!Predicate.isObject(item)) continue;
    const parts =
      item.type === "function_call_output" || item.type === "custom_tool_call_output"
        ? item.output
        : item.content;
    if (!Array.isArray(parts)) continue;
    for (let index = 0; index < parts.length; index++) {
      const part: unknown = parts[index];
      if (Predicate.isObject(part) && part.type === "input_image") images.push({ parts, index });
    }
  }
  for (const { parts, index } of images.slice(0, Math.max(0, images.length - MAX_IMAGES))) {
    parts[index] = { type: "input_text", text: OMITTED_IMAGE };
  }
}

/**
 * Most characters of model-written text replayed from one history item. Codex already caps tool
 * output near this size, but sends the model's own earlier text, reasoning, and tool arguments
 * back in full. One runaway reply can then fill the context window on every later request.
 */
export const MAX_REPLAYED_MODEL_TEXT_CHARS = 40_000;
const REPLAY_TAIL_CHARS = 4_000;

function omittedNotice(omitted: number): string {
  return `\n[TritonAI Harness left out ${omitted.toLocaleString("en-US")} characters of this earlier model output to keep the conversation within the model's context window.]\n`;
}

function boundText(text: string, limit = MAX_REPLAYED_MODEL_TEXT_CHARS): string {
  if (text.length <= limit) return text;
  const tail = Math.min(REPLAY_TAIL_CHARS, Math.floor(limit / 4));
  const head = limit - tail;
  return `${text.slice(0, head)}${omittedNotice(text.length - head - tail)}${text.slice(-tail)}`;
}

function boundJsonStrings(value: unknown): unknown {
  if (typeof value === "string") return boundText(value);
  if (Array.isArray(value)) return value.map(boundJsonStrings);
  if (!Predicate.isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, boundJsonStrings(entry)]),
  );
}

/** Keeps replayed arguments valid JSON: the gateway drops arguments it cannot parse. */
function boundArguments(text: string): string {
  if (text.length <= MAX_REPLAYED_MODEL_TEXT_CHARS) return text;
  try {
    const bounded = JSON.stringify(boundJsonStrings(JSON.parse(text)));
    if (bounded.length <= MAX_REPLAYED_MODEL_TEXT_CHARS + 1_000) return bounded;
  } catch {
    // A reply cut off by the output limit ends mid-string; describe it instead.
  }
  return JSON.stringify({
    omitted_arguments: `${text.slice(0, 2_000)}${omittedNotice(text.length - 2_000)}`,
    note: "These tool arguments were too long to send again. Do not paste large documents or encoded data into a tool call; work in smaller pieces or use a tool that returns text.",
  });
}

function boundTextParts(parts: unknown): void {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (Predicate.isObject(part) && typeof part.text === "string") part.text = boundText(part.text);
  }
}

/** Shorten oversized model-written history items in the request, leaving Codex's record intact. */
export function boundTritonAiReplayedModelOutput(body: unknown): void {
  if (!Predicate.isObject(body) || !Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!Predicate.isObject(item)) continue;
    if (item.type === "function_call" && typeof item.arguments === "string") {
      item.arguments = boundArguments(item.arguments);
    } else if (item.type === "custom_tool_call" && typeof item.input === "string") {
      item.input = boundText(item.input);
    } else if (item.type === "reasoning") {
      boundTextParts(item.summary);
      boundTextParts(item.content);
    } else if (item.type === "message" && item.role === "assistant") {
      boundTextParts(item.content);
    }
  }
}

/**
 * Codex sends no output limit, so the model may keep writing until the context window is full.
 * A runaway reply then makes every later request too large for the model.
 */
export const TRITONAI_MAX_OUTPUT_TOKENS = 32_768;

export function capTritonAiOutputTokens(body: unknown, limit: number | undefined): void {
  if (limit === undefined || !Predicate.isObject(body) || body.max_output_tokens !== undefined)
    return;
  body.max_output_tokens = limit;
}

const CONTEXT_OVERFLOW_PATTERN =
  /ContextWindowExceeded|context_length_exceeded|maximum context length|exceeds the context window/i;

/** LiteLLM reports vLLM context overflow as a generic 400 that Codex cannot act on. */
export function isGatewayContextOverflow(status: number, body: string): boolean {
  return (status === 400 || status === 413) && CONTEXT_OVERFLOW_PATTERN.test(body);
}

/** Share of removable history left out on each retry after the gateway reports an overflow. */
export const HISTORY_TRIM_STEPS = [0.35, 0.6, 0.85, 1] as const;
// The current turn's most recent work stays even when older history is left out.
const KEPT_RECENT_ITEMS = 4;
const TRIM_NOTICE_MARKER = "[TritonAI Harness left out";

function messageText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return "";
  const first = item.content.find(
    (part): part is { text: string } => Predicate.isObject(part) && typeof part.text === "string",
  );
  return first?.text.trimStart() ?? "";
}

/** Instructions and the context Codex injects (AGENTS.md, environment) are never left out. */
function isInstructionMessage(item: Record<string, unknown>): boolean {
  if (item.type !== "message") return false;
  if (item.role === "developer" || item.role === "system") return true;
  if (item.role !== "user") return false;
  const text = messageText(item);
  return (
    !text.startsWith(TRIM_NOTICE_MARKER) &&
    (text.startsWith("<") || text.startsWith("# AGENTS.md instructions"))
  );
}

/** Instruction blocks open with a tag such as `<t3_code_runtime>`; untagged ones are unique. */
function instructionKey(item: Record<string, unknown>): string {
  const text = messageText(item);
  const tag = /^<([A-Za-z0-9_:-]+)/.exec(text)?.[1];
  return tag === undefined ? `${String(item.role)}:${text}` : `${String(item.role)}:<${tag}>`;
}

function pairingKey(item: Record<string, unknown>): string | undefined {
  return typeof item.call_id === "string" ? item.call_id : undefined;
}

/**
 * Leaves out the oldest conversation history from one request after the gateway reports that it
 * no longer fits. Instructions, injected context, the latest user message, and the most recent
 * items stay; tool calls are removed together with their outputs. Codex keeps the full history and
 * compacts it after this request reports its large usage. Returns false when nothing can go.
 */
export function trimTritonAiRequestHistory(body: unknown, share: number): boolean {
  if (!Predicate.isObject(body) || !Array.isArray(body.input)) return false;
  const input = body.input as unknown[];
  const items = input.map((item) => (Predicate.isObject(item) ? item : {}));
  let lastUser = -1;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (
      item.type === "message" &&
      item.role === "user" &&
      !isTrimNotice(item) &&
      !isInstructionMessage(item)
    ) {
      lastUser = index;
      break;
    }
  }
  // Earlier turns may all go; the current turn keeps its most recent items.
  const protectedFrom = Math.max(lastUser, input.length - KEPT_RECENT_ITEMS);
  // Harness and Codex resend instruction blocks; only the newest copy of each must stay.
  const newestInstruction = new Map<string, number>();
  items.forEach((item, index) => {
    if (isInstructionMessage(item)) newestInstruction.set(instructionKey(item), index);
  });
  const candidate = (index: number) => {
    const item = items[index]!;
    if (isTrimNotice(item)) return false;
    if (isInstructionMessage(item)) return newestInstruction.get(instructionKey(item)) !== index;
    return index < lastUser || (index > lastUser && index < protectedFrom);
  };
  // A tool call and its output leave together, and only when both may leave.
  const blockedKeys = new Set<string>();
  items.forEach((item, index) => {
    const key = pairingKey(item);
    if (key !== undefined && !candidate(index)) blockedKeys.add(key);
  });
  const removable = items
    .map((item, index) => ({ index, item }))
    .filter(({ item, index }) => {
      const key = pairingKey(item);
      return candidate(index) && (key === undefined || !blockedKeys.has(key));
    });
  if (removable.length === 0) return false;
  const sizes = removable.map(({ item }) => JSON.stringify(item).length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const target = total * Math.min(1, Math.max(0, share));
  const removedKeys = new Set<string>();
  const removed = new Set<number>();
  let removedBytes = 0;
  for (let position = 0; position < removable.length && removedBytes < target; position++) {
    const { index, item } = removable[position]!;
    removed.add(index);
    removedBytes += sizes[position]!;
    const key = pairingKey(item);
    if (key !== undefined) removedKeys.add(key);
  }
  for (const { index, item } of removable) {
    const key = pairingKey(item);
    if (key !== undefined && removedKeys.has(key)) removed.add(index);
  }
  if (removed.size === 0) return false;
  const previousNotice = items.findIndex(isTrimNotice);
  const previouslyLeftOut = previousNotice < 0 ? 0 : leftOutCount(items[previousNotice]!);
  const leftOut = previouslyLeftOut + removed.size;
  const first = Math.min(...removed);
  const notice = {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `${TRIM_NOTICE_MARKER} ${leftOut} earlier conversation items because the conversation no longer fits the model's context window. Continue from the recent messages below.]`,
      },
    ],
  };
  body.input = input.flatMap((item, index) => {
    if (index === first) return [notice];
    if (removed.has(index) || index === previousNotice) return [];
    return [item];
  });
  return true;
}

function isTrimNotice(item: Record<string, unknown>): boolean {
  return (
    item.type === "message" &&
    item.role === "user" &&
    Array.isArray(item.content) &&
    item.content.some(
      (part) =>
        Predicate.isObject(part) &&
        typeof part.text === "string" &&
        part.text.startsWith(TRIM_NOTICE_MARKER),
    )
  );
}

function leftOutCount(item: Record<string, unknown>): number {
  const text = JSON.stringify(item.content);
  const match = /left out (\d+) earlier/.exec(text);
  return match ? Number(match[1]) : 0;
}

const CONTEXT_OVERFLOW_MESSAGE =
  "This conversation is longer than the selected model can read at once.";

/**
 * Codex recognizes context overflow only as a streamed `context_length_exceeded` failure. Used
 * when leaving out history cannot make the request fit, so the turn ends with a clear error.
 */
export function contextOverflowEventStream(): string {
  const event = {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: `resp_tritonai_context_${NodeCrypto.randomUUID()}`,
      object: "response",
      status: "failed",
      error: { code: "context_length_exceeded", message: CONTEXT_OVERFLOW_MESSAGE },
    },
  };
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isActionableItem(item: unknown): boolean {
  return (
    Predicate.isObject(item) &&
    (item.type === "function_call" || item.type === "custom_tool_call" || item.type === "message")
  );
}

/**
 * Codex retries an incomplete reply as a stream failure, so a reply that hit the output limit
 * would be generated again up to the retry limit. When the stream already delivered a tool call or
 * message (Codex acts only on `response.output_item.done`), accept the reply instead: Codex reports
 * a cut-off tool call to the model, which can then change approach. Any other incomplete reply,
 * such as one with only reasoning, stays incomplete and keeps Codex's retry.
 */
export function acceptOutputLimitedEvent(data: string, deliveredActionableItem: boolean): string {
  if (!deliveredActionableItem) return data;
  if (!data.includes('"response.incomplete"') || !data.includes("max_output_tokens")) return data;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return data;
  }
  if (!Predicate.isObject(event) || event.type !== "response.incomplete") return data;
  const response = event.response;
  if (!Predicate.isObject(response)) return data;
  const details = response.incomplete_details;
  if (!Predicate.isObject(details) || details.reason !== "max_output_tokens") return data;
  return JSON.stringify({
    ...event,
    type: "response.completed",
    response: { ...response, status: "completed" },
  });
}

/** Rewrites one response stream's events, remembering which output items Codex received. */
export function makeResponseEventRewriter(): (data: string) => string {
  let deliveredActionableItem = false;
  return (data) => {
    if (!deliveredActionableItem && data.includes('"response.output_item.done"')) {
      try {
        const event: unknown = JSON.parse(data);
        if (
          Predicate.isObject(event) &&
          event.type === "response.output_item.done" &&
          isActionableItem(event.item)
        )
          deliveredActionableItem = true;
      } catch {
        // Not an event Codex can parse either; pass it through unchanged.
      }
    }
    return acceptOutputLimitedEvent(data, deliveredActionableItem);
  };
}

function rewriteSseEvent(event: string, rewrite: (data: string) => string): string {
  return event
    .split("\n")
    .map((line) =>
      line.startsWith("data:") ? `data: ${rewrite(line.slice(5).trimStart())}` : line,
    )
    .join("\n");
}

/** Rewrites complete server-sent events while preserving streaming order and partial chunks. */
export function rewriteResponseEvents<E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  rewrite: (data: string) => string = makeResponseEventRewriter(),
): Stream.Stream<Uint8Array, E, R> {
  return stream.pipe(
    Stream.decodeText,
    Stream.mapAccum(
      () => "",
      (pending: string, chunk: string) => {
        const text = (pending + chunk).replace(/\r\n/g, "\n");
        const boundary = text.lastIndexOf("\n\n");
        if (boundary < 0) return [text, []] as const;
        const complete = text.slice(0, boundary + 2);
        const events = complete.split("\n\n").slice(0, -1);
        return [
          text.slice(boundary + 2),
          [events.map((event) => `${rewriteSseEvent(event, rewrite)}\n\n`).join("")],
        ] as const;
      },
      { onHalt: (pending) => (pending.length > 0 ? [rewriteSseEvent(pending, rewrite)] : []) },
    ),
    Stream.encodeText,
  );
}

// Rewritten bodies get new framing from the local server.
const HOP_BY_HOP_HEADERS = ["connection", "content-length", "transfer-encoding", "set-cookie"];

export interface TritonAiGatewayProxyOptions {
  /** Output-token limit for a requested model, or undefined to send the request unchanged. */
  readonly outputTokenLimit?: (model: string) => number | undefined;
}

/** A scoped request filter; Effect owns sockets, streaming, cancellation, and cleanup. */
export const makeTritonAiGatewayProxy = Effect.fn("makeTritonAiGatewayProxy")(function* (
  upstreamBaseUrl: string,
  environment: NodeJS.ProcessEnv,
  options: TritonAiGatewayProxyOptions = {},
) {
  const upstream = yield* Effect.try(() => new URL(upstreamBaseUrl));
  const allProxy = environment.all_proxy || environment.ALL_PROXY;
  const dispatcher = yield* Effect.acquireRelease(
    Effect.try(
      () =>
        new EnvHttpProxyAgent({
          httpProxy: environment.http_proxy || environment.HTTP_PROXY || allProxy || "",
          httpsProxy: environment.https_proxy || environment.HTTPS_PROXY || allProxy || "",
          noProxy: environment.no_proxy || environment.NO_PROXY || "",
        }),
    ),
    (agent) => Effect.promise(() => agent.destroy()),
  );
  const client = yield* NodeHttpClient.makeUndici.pipe(
    Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
  );
  const prefix = `/${NodeCrypto.randomUUID()}`;
  const server = yield* NodeHttpServer.make(NodeHttp.createServer, {
    host: "127.0.0.1",
    port: 0,
    disablePreemptiveShutdown: true,
  });
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const local = new URL(request.url, "http://localhost");
      if (!local.pathname.startsWith(`${prefix}/`))
        return HttpServerResponse.empty({ status: 404 });
      const suffix = local.pathname.slice(prefix.length);
      const target = new URL(upstream);
      target.pathname = upstream.pathname.replace(/\/$/, "") + suffix;
      for (const [key, value] of local.searchParams) target.searchParams.set(key, value);
      let body: HttpBody.HttpBody = HttpBody.stream(request.stream);
      const isResponses = request.method === "POST" && suffix === "/responses";
      let streaming = false;
      let parsed: unknown;
      if (isResponses || (request.method === "POST" && suffix === "/responses/compact")) {
        const input = yield* request.json;
        parsed = input;
        limitTritonAiRequestImages(input);
        boundTritonAiReplayedModelOutput(input);
        if (isResponses && Predicate.isObject(input)) {
          streaming = input.stream === true;
          if (typeof input.model === "string")
            capTritonAiOutputTokens(input, options.outputTokenLimit?.(input.model));
        }
        body = HttpBody.jsonUnsafe(input);
      }
      const headers = Headers.removeMany(request.headers, [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
      ]);
      const send = (payload: HttpBody.HttpBody) =>
        client.execute(HttpClientRequest.make(request.method)(target, { headers, body: payload }));
      let response = yield* send(body);
      if (!isResponses) return HttpServerResponse.fromClientResponse(response);
      if (response.status === 400 || response.status === 413) {
        let text = yield* response.text;
        // Leave out progressively more old history until the request fits the model again.
        for (const share of streaming ? HISTORY_TRIM_STEPS : []) {
          if (!isGatewayContextOverflow(response.status, text)) break;
          if (!trimTritonAiRequestHistory(parsed, share)) break;
          response = yield* send(HttpBody.jsonUnsafe(parsed));
          if (response.status !== 400 && response.status !== 413) break;
          text = yield* response.text;
        }
        if (response.status === 400 || response.status === 413) {
          const forwarded = Headers.removeMany(response.headers, [
            ...HOP_BY_HOP_HEADERS,
            "content-type",
          ]);
          if (streaming && isGatewayContextOverflow(response.status, text))
            return HttpServerResponse.text(contextOverflowEventStream(), {
              contentType: "text/event-stream",
              headers: forwarded,
            });
          const contentType = response.headers["content-type"];
          return HttpServerResponse.text(text, {
            status: response.status,
            headers: forwarded,
            ...(contentType ? { contentType } : {}),
          });
        }
      }
      if (!streaming || response.status !== 200)
        return HttpServerResponse.fromClientResponse(response);
      return HttpServerResponse.stream(rewriteResponseEvents(response.stream), {
        status: response.status,
        headers: Headers.removeMany(response.headers, HOP_BY_HOP_HEADERS),
      });
    }).pipe(
      Effect.catchTags({
        HttpClientError: () => Effect.succeed(HttpServerResponse.empty({ status: 502 })),
      }),
    ),
  );
  return `${HttpServer.formatAddress(server.address)}${prefix}`;
});
