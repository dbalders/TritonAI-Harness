// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Exercise the real loopback HTTP boundary, including raw Host headers.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AccountLoginCallback } from "./AccountLoginCallback.ts";

const callbacks = new AccountLoginCallback();
afterEach(() => {
  callbacks.close();
  vi.useRealTimers();
});
const token = () => NodeCrypto.randomBytes(32).toString("base64url");
function completionUrl(returnUrl: string) {
  const result = { requestId: token(), completionCode: token() };
  const url = new URL(returnUrl);
  for (const [key, value] of Object.entries(result)) url.searchParams.set(key, value);
  return { url, result };
}

describe("desktop account callback", () => {
  it("receives a browser handoff only for its owning window and permits retrying delivery to the backend", async () => {
    let activated = 0;
    const receiver = await callbacks.prepare(11, () => activated++);
    const { url, result } = completionUrl(receiver.returnUrl);
    expect(callbacks.read(11, receiver.id)).toBeNull();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(result.completionCode);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(activated).toBe(1);
    expect(callbacks.read(12, receiver.id)).toBeNull();
    expect(callbacks.read(11, receiver.id)).toEqual(result);
    expect(callbacks.read(11, receiver.id)).toEqual(result);
    callbacks.cancel(11, receiver.id);
    expect(callbacks.read(11, receiver.id)).toBeNull();
  });

  it("rejects wrong paths, methods, hosts, and malformed or duplicate codes without consuming the callback", async () => {
    const receiver = await callbacks.prepare(11, () => {});
    const { url, result } = completionUrl(receiver.returnUrl);
    expect((await fetch(new URL("/wrong", url))).status).toBe(400);
    expect((await fetch(url, { method: "POST" })).status).toBe(400);
    const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = NodeHttp.request(url, { headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    expect(wrongHostStatus).toBe(400);
    const bad = new URL(url);
    bad.searchParams.set("completionCode", "bad");
    expect((await fetch(bad)).status).toBe(400);
    bad.searchParams.set("completionCode", result.completionCode);
    bad.searchParams.append("completionCode", result.completionCode);
    expect((await fetch(bad)).status).toBe(400);
    expect(callbacks.read(11, receiver.id)).toBeNull();
    expect((await fetch(url)).status).toBe(200);
  });

  it("keeps concurrent environment flows in one window independent and prevents another window from cancelling them", async () => {
    const first = await callbacks.prepare(11, () => {});
    const second = await callbacks.prepare(11, () => {});
    const firstCompletion = completionUrl(first.returnUrl);
    expect((await fetch(firstCompletion.url)).status).toBe(200);
    expect(callbacks.read(11, first.id)).toEqual(firstCompletion.result);
    callbacks.cancel(12, second.id);
    expect((await fetch(completionUrl(second.returnUrl).url)).status).toBe(200);
    callbacks.close();
    expect(callbacks.read(11, first.id)).toBeNull();
    expect(callbacks.read(11, second.id)).toBeNull();
  });

  it("expires the receiver and its retained completion proof", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const receiver = await callbacks.prepare(11, () => {}, 1_000);
    const { url, result } = completionUrl(receiver.returnUrl);
    expect((await fetch(url)).status).toBe(200);
    expect(callbacks.read(11, receiver.id)).toEqual(result);
    vi.advanceTimersByTime(1_000);
    expect(callbacks.read(11, receiver.id)).toBeNull();
  });
});
