// @effect-diagnostics nodeBuiltinImport:off -- This native adapter owns an ephemeral loopback HTTP listener.
// @effect-diagnostics globalTimers:off -- Bound the native listener lifetime outside an Effect fiber.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

interface Completion {
  requestId: string;
  completionCode: string;
}
interface Pending {
  owner: number;
  server: NodeHttp.Server;
  timer: ReturnType<typeof setTimeout>;
  result: Completion | null;
}

/** The receiver runs on the user's desktop, including when their Harness backend is remote. */
export class AccountLoginCallback {
  private readonly pending = new Map<string, Pending>();

  async prepare(owner: number, onComplete: () => void, ttlMs = 600_000) {
    const id = NodeCrypto.randomBytes(32).toString("base64url");
    const path = `/account/callback/${id}`;
    let host = "";
    const server = NodeHttp.createServer((request, response) => {
      if (!request.url?.startsWith(`${path}?`) || request.url.length > 2048) {
        response.writeHead(400).end("Invalid sign-in callback.");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pending = this.pending.get(id);
      const requestId = url.searchParams.get("requestId") ?? "";
      const completionCode = url.searchParams.get("completionCode") ?? "";
      const valid =
        request.method === "GET" &&
        request.headers.host === host &&
        url.pathname === path &&
        url.origin === "http://127.0.0.1" &&
        /^[A-Za-z0-9_-]{43}$/u.test(requestId) &&
        /^[A-Za-z0-9_-]{43}$/u.test(completionCode) &&
        url.searchParams.getAll("requestId").length === 1 &&
        url.searchParams.getAll("completionCode").length === 1;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (!valid || !pending || pending.result) {
        response.writeHead(400).end("This sign-in callback is invalid or expired.");
        return;
      }
      pending.result = { requestId, completionCode };
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><html lang="en"><title>Returning to TritonAI Harness</title><h1>Returning to TritonAI Harness</h1><p>You can close this browser tab.</p></html>',
      );
      server.close();
      onComplete();
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not open the desktop sign-in callback.");
    }
    host = `127.0.0.1:${address.port}`;
    const timer = setTimeout(() => this.cancel(owner, id), ttlMs);
    timer.unref();
    this.pending.set(id, { owner, server, timer, result: null });
    return { id, returnUrl: `http://${host}${path}` };
  }

  read(owner: number, id: string): Completion | null {
    const pending = this.pending.get(id);
    return pending?.owner === owner ? pending.result : null;
  }

  cancel(owner: number, id: string): void {
    const pending = this.pending.get(id);
    if (!pending || pending.owner !== owner) return;
    clearTimeout(pending.timer);
    pending.server.close();
    pending.server.closeAllConnections();
    this.pending.delete(id);
  }

  close(): void {
    for (const [id, pending] of this.pending) this.cancel(pending.owner, id);
  }
}
