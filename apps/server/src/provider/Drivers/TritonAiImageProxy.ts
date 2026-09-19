// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import {
  Headers,
  HttpBody,
  HttpClientRequest,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

// Leave one image of headroom below the gateway's four-image limit.
const MAX_IMAGES = 3;
const OMITTED_IMAGE =
  "[Earlier image omitted from this request; use the latest screenshots below.]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bound model-visible images without changing the stored transcript or tool-call pairing. */
export function limitTritonAiRequestImages(body: unknown): void {
  if (!isRecord(body) || !Array.isArray(body.input)) return;
  const images: Array<{ parts: unknown[]; index: number }> = [];
  for (const item of body.input) {
    if (!isRecord(item)) continue;
    const parts =
      item.type === "function_call_output" || item.type === "custom_tool_call_output"
        ? item.output
        : item.content;
    if (!Array.isArray(parts)) continue;
    for (let index = 0; index < parts.length; index++) {
      const part: unknown = parts[index];
      if (isRecord(part) && part.type === "input_image") images.push({ parts, index });
    }
  }
  for (const { parts, index } of images.slice(0, Math.max(0, images.length - MAX_IMAGES))) {
    parts[index] = { type: "input_text", text: OMITTED_IMAGE };
  }
}

/** A scoped request filter; Effect owns sockets, streaming, cancellation, and cleanup. */
export const makeTritonAiImageProxy = Effect.fn("makeTritonAiImageProxy")(function* (
  upstreamBaseUrl: string,
  environment: NodeJS.ProcessEnv,
) {
  const upstream = yield* Effect.try(() => new URL(upstreamBaseUrl));
  const allProxy = environment.all_proxy || environment.ALL_PROXY;
  const agents = yield* NodeHttpClient.makeAgent({
    keepAlive: true,
    proxyEnv: {
      http_proxy: environment.http_proxy || environment.HTTP_PROXY || allProxy,
      https_proxy: environment.https_proxy || environment.HTTPS_PROXY || allProxy,
      no_proxy: environment.no_proxy || environment.NO_PROXY,
    },
  });
  const client = yield* NodeHttpClient.makeNodeHttp.pipe(
    Effect.provideService(NodeHttpClient.HttpAgent, agents),
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
      if (
        request.method === "POST" &&
        (suffix === "/responses" || suffix === "/responses/compact")
      ) {
        const input = yield* request.json;
        limitTritonAiRequestImages(input);
        body = HttpBody.jsonUnsafe(input);
      }
      const headers = Headers.removeMany(request.headers, [
        "host",
        "connection",
        "content-length",
        "transfer-encoding",
      ]);
      return HttpServerResponse.fromClientResponse(
        yield* client.execute(HttpClientRequest.make(request.method)(target, { headers, body })),
      );
    }).pipe(
      Effect.catchTag("HttpClientError", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 502 })),
      ),
    ),
  );
  return `${HttpServer.formatAddress(server.address)}${prefix}`;
});
