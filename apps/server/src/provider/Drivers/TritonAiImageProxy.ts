// Byte-preserving HTTP forwarding keeps SSE, upstream status, and compressed responses intact.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

// Leave one image of headroom below the gateway's four-image limit.
const MAX_IMAGES = 3;
const MAX_BODY_BYTES = 128 * 1024 * 1024;
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

function decodeBody(bytes: Buffer, encoding: string | undefined): Buffer {
  const options = { maxOutputLength: MAX_BODY_BYTES };
  switch (encoding?.toLowerCase()) {
    case undefined:
    case "identity":
      return bytes;
    case "gzip":
      return NodeZlib.gunzipSync(bytes, options);
    case "deflate":
      return NodeZlib.inflateSync(bytes, options);
    case "br":
      return NodeZlib.brotliDecompressSync(bytes, options);
    case "zstd":
      return NodeZlib.zstdDecompressSync(bytes, options);
    default:
      throw new Error("Unsupported request encoding");
  }
}

/** Session-owned loopback transport; the upstream URL and credentials remain provider-owned. */
export async function startTritonAiImageProxy(
  upstreamBaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const upstream = new URL(upstreamBaseUrl);
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new Error("TritonAI requires an HTTP or HTTPS API URL");
  }
  const allProxy = environment.all_proxy || environment.ALL_PROXY;
  const proxyEnv = {
    http_proxy: environment.http_proxy || environment.HTTP_PROXY || allProxy,
    https_proxy: environment.https_proxy || environment.HTTPS_PROXY || allProxy,
    no_proxy: environment.no_proxy || environment.NO_PROXY,
  };
  const agent =
    upstream.protocol === "https:"
      ? new NodeHttps.Agent({ keepAlive: true, proxyEnv })
      : new NodeHttp.Agent({ keepAlive: true, proxyEnv });
  const prefix = `/${NodeCrypto.randomUUID()}`;
  const requests = new Set<NodeHttp.ClientRequest>();
  const server = NodeHttp.createServer((request, response) => {
    const handle = async () => {
      const localUrl = new URL(request.url ?? "/", "http://localhost");
      if (!localUrl.pathname.startsWith(`${prefix}/`)) {
        response.writeHead(404).end();
        return;
      }
      const suffix = localUrl.pathname.slice(prefix.length);
      const target = new URL(upstream);
      target.pathname = upstream.pathname.replace(/\/$/, "") + suffix;
      target.search = localUrl.search || upstream.search;
      const headers = { ...request.headers, host: target.host };
      delete headers.connection;
      let body: Buffer | undefined;
      if (
        request.method === "POST" &&
        (suffix === "/responses" || suffix === "/responses/compact")
      ) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > MAX_BODY_BYTES) {
            response.writeHead(413).end("TritonAI request exceeds the image transport size limit");
            return;
          }
          chunks.push(bytes);
        }
        const parsed: unknown = JSON.parse(
          decodeBody(Buffer.concat(chunks), request.headers["content-encoding"]).toString("utf8"),
        );
        limitTritonAiRequestImages(parsed);
        body = Buffer.from(JSON.stringify(parsed));
        delete headers["content-encoding"];
        delete headers["transfer-encoding"];
        headers["content-length"] = String(body.length);
      }
      if (response.destroyed) return;
      const send = target.protocol === "https:" ? NodeHttps.request : NodeHttp.request;
      const forwarded = send(target, { method: request.method, headers, agent }, (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.on("error", () => response.destroy());
        incoming.pipe(response);
      });
      requests.add(forwarded);
      forwarded.on("close", () => requests.delete(forwarded));
      forwarded.on("error", () => {
        if (response.headersSent) response.destroy();
        else response.writeHead(502).end("TritonAI upstream request failed");
      });
      response.on("close", () => forwarded.destroy());
      request.on("error", () => forwarded.destroy());
      if (body) forwarded.end(body);
      else request.pipe(forwarded);
    };
    void handle().catch(() => {
      if (response.headersSent) response.destroy();
      else response.writeHead(400).end("Invalid TritonAI API request");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing image proxy address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}${prefix}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const request of requests) request.destroy();
        agent.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
