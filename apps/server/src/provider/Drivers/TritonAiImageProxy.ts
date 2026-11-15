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
import {
  PLUGIN_TOOL_DISCOVERY_NAME,
  PLUGIN_TOOL_LOADER_NAME,
} from "../CodexPluginToolDiscovery.ts";

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

const TOOL_SEARCH = "tool_search";
const MAX_SEARCH_RESULTS = 8;
const OPERATION_NAME = /^[A-Za-z0-9_-]+$/u;
// An unindexed query prefix retains load intent across restart and compaction in native history.
const EXACT_QUERY_PREFIX = "__tritonai_exact_plugin_load_v1__ ";
const EXACT_LOADER = {
  type: "function",
  name: PLUGIN_TOOL_LOADER_NAME,
  description:
    `Load the typed schema for one plugin operation. First browse ${PLUGIN_TOOL_DISCOVERY_NAME}, ` +
    "then copy an exact entries[].name. This accepts operation names, not natural-language searches. " +
    "If no exact operation matches, browse again rather than substituting another operation.",
  strict: false,
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        pattern: OPERATION_NAME.source,
        description: `Exact entries[].name returned by ${PLUGIN_TOOL_DISCOVERY_NAME}.`,
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
};
interface PluginToolIdentity {
  readonly namespace: string;
  readonly name: string;
}
const SEARCH_GUIDANCE =
  `For plugin tasks, first use ${PLUGIN_TOOL_DISCOVERY_NAME}, when available, to browse operation names. ` +
  "Then search for the exact returned name with limit 1 to load its schema. " +
  "Otherwise search by service and required operation, rather than the user's data values. " +
  "Results are candidates: if the requested operation is missing, search again with alternate " +
  "words or an exact tool name. An account lookup does not list resources, and a folder listing " +
  "does not search documents. Each search loads at most eight tools; use another focused search " +
  "when more capabilities are needed.";

function loadedToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!Predicate.isObject(tool)) return [];
    if (tool.type === "namespace" && Array.isArray(tool.tools))
      return tool.tools.flatMap((inner) =>
        Predicate.isObject(inner) && typeof inner.name === "string" ? [inner.name] : [],
      );
    return typeof tool.name === "string" ? [tool.name] : [];
  });
}

function withoutDeferLoading(tool: unknown): unknown {
  if (!Predicate.isObject(tool)) return tool;
  const { defer_loading: _deferLoading, ...rest } = tool;
  return rest.type === "namespace" && Array.isArray(rest.tools)
    ? { ...rest, tools: rest.tools.map(withoutDeferLoading) }
    : rest;
}

function exactToolResults(tools: unknown, name: string, plugins?: ReadonlySet<string>): unknown[] {
  if (!Array.isArray(tools) || name === "") return [];
  return tools.flatMap((tool) => {
    if (!Predicate.isObject(tool)) return [];
    if (tool.type !== "namespace") return plugins === undefined && tool.name === name ? [tool] : [];
    if (plugins !== undefined && !plugins.has(JSON.stringify([tool.name, name]))) return [];
    const matching = Array.isArray(tool.tools)
      ? tool.tools.filter((inner) => Predicate.isObject(inner) && inner.name === name)
      : [];
    return matching.length > 0 ? [{ ...tool, tools: matching }] : [];
  });
}

function withoutPluginResults(tools: unknown, plugins: ReadonlySet<string>): unknown[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!Predicate.isObject(tool)) return [];
    if (tool.type !== "namespace" || !Array.isArray(tool.tools)) return [tool];
    const matching = tool.tools.filter(
      (inner) => Predicate.isObject(inner) && !plugins.has(JSON.stringify([tool.name, inner.name])),
    );
    return matching.length > 0 ? [{ ...tool, tools: matching }] : [];
  });
}

/** Adds tools found by an earlier search, merging into a namespace already in the request. */
function addLoadedTools(requestTools: unknown[], loaded: unknown): void {
  if (!Array.isArray(loaded)) return;
  for (const tool of loaded.map(withoutDeferLoading)) {
    if (!Predicate.isObject(tool)) continue;
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      const existing = requestTools.find(
        (entry): entry is Record<string, unknown> & { tools: unknown[] } =>
          Predicate.isObject(entry) &&
          entry.type === "namespace" &&
          entry.name === tool.name &&
          Array.isArray(entry.tools),
      );
      const target = existing ?? { ...tool, tools: [] as unknown[] };
      if (existing === undefined) requestTools.push(target);
      const present = new Set(loadedToolNames(target.tools));
      for (const inner of tool.tools) {
        if (!Predicate.isObject(inner) || present.has(String(inner.name))) continue;
        present.add(String(inner.name));
        target.tools.push(inner);
      }
    } else if (!loadedToolNames(requestTools).includes(String(tool.name))) {
      requestTools.push(tool);
    }
  }
}

/**
 * The campus route rejects native search history. Replay it as function calls, exposing found
 * tools only when search is offered; compaction receives no tools. Preserve namespaces and
 * return whether the response needs reverse translation.
 */
export function translateToolSearchForGateway(
  body: unknown,
  pluginTools?: ReadonlyArray<PluginToolIdentity>,
): boolean {
  if (!Predicate.isObject(body)) return false;
  let searchable = false;
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
  const exactLoading = loadedToolNames(tools).includes(PLUGIN_TOOL_DISCOVERY_NAME);
  const plugins = new Set(pluginTools?.map((tool) => JSON.stringify([tool.namespace, tool.name])));
  body.tools = tools.flatMap((tool) => {
    if (!Predicate.isObject(tool) || tool.type !== TOOL_SEARCH) return [tool];
    searchable = true;
    const search = {
      type: "function",
      name: TOOL_SEARCH,
      description: exactLoading
        ? `Search deferred MCP extension tools. For Harness plugins, browse ${PLUGIN_TOOL_DISCOVERY_NAME} ` +
          `and use ${PLUGIN_TOOL_LOADER_NAME} with an exact operation name.`
        : [tool.description, SEARCH_GUIDANCE].filter(Boolean).join("\n\n"),
      strict: false,
      parameters: tool.parameters,
    };
    return exactLoading ? [EXACT_LOADER] : [search];
  });
  if (!Array.isArray(body.input)) return searchable;
  const exactLoads = new Map<unknown, string>();
  body.input = body.input.map((item) => {
    if (!Predicate.isObject(item)) return item;
    if (item.type === "tool_search_call") {
      const args = item.arguments;
      const name =
        Predicate.isObject(args) &&
        typeof args.query === "string" &&
        args.query.startsWith(EXACT_QUERY_PREFIX)
          ? args.query.slice(EXACT_QUERY_PREFIX.length)
          : undefined;
      if (name !== undefined) exactLoads.set(item.call_id, name);
      return {
        type: "function_call",
        call_id: item.call_id,
        name: name === undefined ? TOOL_SEARCH : PLUGIN_TOOL_LOADER_NAME,
        arguments: JSON.stringify(name === undefined ? (args ?? {}) : { name }),
      };
    }
    if (item.type === "tool_search_output") {
      const exactName = exactLoads.get(item.call_id);
      const found =
        exactName !== undefined
          ? exactToolResults(item.tools, exactName, pluginTools === undefined ? undefined : plugins)
          : exactLoading && pluginTools !== undefined
            ? withoutPluginResults(item.tools, plugins)
            : item.tools;
      if (searchable) addLoadedTools(body.tools as unknown[], found);
      const names = loadedToolNames(found);
      return {
        type: "function_call_output",
        call_id: item.call_id,
        output:
          exactName !== undefined && names.length === 0
            ? (exactName === ""
                ? "Invalid operation name."
                : `No exact operation named ${exactName}.`) +
              ` Browse ${PLUGIN_TOOL_DISCOVERY_NAME} and copy a returned operation name.`
            : names.length === 0
              ? exactLoading
                ? `No matching MCP tools. Browse ${PLUGIN_TOOL_DISCOVERY_NAME} for plugin operations.`
                : "No matching tools were found."
              : `These tools are now available to call: ${names.join(", ")}.`,
      };
    }
    return item;
  });
  return searchable;
}

function toToolSearchCall(item: unknown, exactLoading: boolean): unknown {
  if (
    !Predicate.isObject(item) ||
    item.type !== "function_call" ||
    (item.name !== TOOL_SEARCH && !(exactLoading && item.name === PLUGIN_TOOL_LOADER_NAME)) ||
    item.namespace != null
  )
    return item;
  let parsed: unknown = {};
  if (typeof item.arguments === "string" && item.arguments.trim().length > 0) {
    try {
      parsed = JSON.parse(item.arguments);
    } catch {
      parsed = { query: item.arguments };
    }
  }
  if (exactLoading && item.status !== "in_progress") {
    parsed = {
      query:
        item.name === PLUGIN_TOOL_LOADER_NAME &&
        Predicate.isObject(parsed) &&
        typeof parsed.name === "string" &&
        OPERATION_NAME.test(parsed.name)
          ? EXACT_QUERY_PREFIX + parsed.name
          : EXACT_QUERY_PREFIX,
      // Native ranking can put a same-named MCP extension ahead of the registered plugin.
      // Only the exact registered pair is exposed when these local candidates are replayed.
      limit: MAX_SEARCH_RESULTS,
    };
  }
  // A broad discovery call must not defeat deferral by loading the entire catalog.
  if (
    Predicate.isObject(parsed) &&
    typeof parsed.limit === "number" &&
    parsed.limit > MAX_SEARCH_RESULTS
  )
    parsed = { ...parsed, limit: MAX_SEARCH_RESULTS };
  return {
    type: "tool_search_call",
    ...(item.id === undefined ? {} : { id: item.id }),
    call_id: item.call_id ?? null,
    status: item.status ?? "completed",
    execution: "client",
    arguments: Predicate.isObject(parsed) ? parsed : {},
  };
}

/** Returns a gateway `tool_search` function call to Codex as its client-side search call. */
export function toCodexToolSearchEvent(data: string, { exactLoading = false } = {}): string {
  if (!data.includes(`"${TOOL_SEARCH}"`) && !data.includes(`"${PLUGIN_TOOL_LOADER_NAME}"`))
    return data;
  let event: unknown;
  try {
    event = JSON.parse(data);
  } catch {
    return data;
  }
  if (!Predicate.isObject(event)) return data;
  // Codex reads calls from the item events, not from response.completed's output.
  if ("item" in event)
    return JSON.stringify({
      ...event,
      item: toToolSearchCall(event.item, exactLoading),
    });
  return data;
}

/** Rewrites one event's data, which SSE allows to span several `data:` lines. */
function rewriteSseEvent(event: string, rewrite: (data: string) => string): string {
  const lines = event.split("\n");
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return event;
  const data = dataLines.map((line) => line.slice(line.startsWith("data: ") ? 6 : 5)).join("\n");
  const rewritten = rewrite(data);
  if (rewritten === data) return event;
  const first = lines.indexOf(dataLines[0]!);
  return lines
    .flatMap((line, index) =>
      index === first ? [`data: ${rewritten}`] : line.startsWith("data:") ? [] : [line],
    )
    .join("\n");
}

/** Rewrites complete server-sent events while preserving streaming order and partial chunks. */
function rewriteResponseEvents<E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  rewrite: (data: string) => string,
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

export interface TritonAiImageProxyOptions {
  /** Whether a requested model needs Codex tool search translated into an ordinary function. */
  readonly translateToolSearch?: (model: string) => boolean;
  /** Registry identities distinguish plugins from separately configured MCP tools. */
  readonly pluginTools?: () => ReadonlyArray<PluginToolIdentity>;
}

/** A scoped request filter; Effect owns sockets, streaming, cancellation, and cleanup. */
export const makeTritonAiImageProxy = Effect.fn("makeTritonAiImageProxy")(function* (
  upstreamBaseUrl: string,
  environment: NodeJS.ProcessEnv,
  options: TritonAiImageProxyOptions = {},
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
      let rewriteSearchReply = false;
      let exactLoading = false;
      if (
        request.method === "POST" &&
        (suffix === "/responses" || suffix === "/responses/compact")
      ) {
        const input = yield* request.json;
        limitTritonAiRequestImages(input);
        if (
          Predicate.isObject(input) &&
          typeof input.model === "string" &&
          options.translateToolSearch?.(input.model) === true
        ) {
          exactLoading = loadedToolNames(input.tools).includes(PLUGIN_TOOL_DISCOVERY_NAME);
          rewriteSearchReply =
            translateToolSearchForGateway(input, options.pluginTools?.()) && input.stream === true;
        }
        body = HttpBody.jsonUnsafe(input);
      }
      const headers = Headers.removeMany(request.headers, [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
        // A reply rewritten as text must arrive uncompressed.
        ...(rewriteSearchReply ? ["accept-encoding"] : []),
      ]);
      const response = yield* client.execute(
        HttpClientRequest.make(request.method)(target, { headers, body }),
      );
      if (!rewriteSearchReply || response.status !== 200)
        return HttpServerResponse.fromClientResponse(response);
      return HttpServerResponse.stream(
        rewriteResponseEvents(response.stream, (data) =>
          toCodexToolSearchEvent(data, {
            exactLoading,
          }),
        ),
        {
          status: response.status,
          headers: Headers.removeMany(response.headers, HOP_BY_HOP_HEADERS),
        },
      );
    }).pipe(
      Effect.catchTags({
        HttpClientError: () => Effect.succeed(HttpServerResponse.empty({ status: 502 })),
      }),
    ),
  );
  return `${HttpServer.formatAddress(server.address)}${prefix}`;
});
