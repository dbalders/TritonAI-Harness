import { describe, expect, it, vi } from "vite-plus/test";
import {
  DotApiError,
  DotClient,
  readDotSession,
  saveDotSession,
  runStatusLabel,
} from "./dotClient";

const session = {
  ownerToken: "synthetic-owner-session",
  expiresAt: Date.now() / 1000 + 3600,
  email: "owner@ucsd.edu",
};

describe("DotClient", () => {
  it("binds the native browser fetch to its global receiver", async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({ ok: true, tasks: [], runs: [], approvals: [] }));
    };
    try {
      await expect(new DotClient("https://bot.example.test").state(session)).resolves.toMatchObject(
        { runs: [] },
      );
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
  it("sends owner authentication and preserves request IDs through a failed send and retry", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network interrupted"))
      .mockResolvedValue(
        Response.json({ ok: true, runId: "run-1", status: "queued" }, { status: 202 }),
      );
    const client = new DotClient("https://bot.example.test", mock);
    const message = { requestId: "request-1", threadId: "thread-1", text: "Hello" };
    await expect(client.send(session, message)).rejects.toThrow("network interrupted");
    await expect(client.send(session, message)).resolves.toMatchObject({
      runId: "run-1",
      status: "queued",
    });
    for (const [, init] of mock.mock.calls) {
      expect(init?.headers).toEqual({
        Authorization: `Bearer ${session.ownerToken}`,
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual(message);
      expect(init?.credentials).toBe("omit");
    }
  });

  it("reads completed replies and retains meaningful asynchronous statuses", async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        run: { runId: "run-1", status: "completed", result: { summary: "Hello back" } },
      }),
    );
    const client = new DotClient("https://bot.example.test", mock);
    expect((await client.run(session, "run-1")).run.result?.summary).toBe("Hello back");
    expect(mock.mock.calls[0]?.[0]).toBe("https://bot.example.test/runs/run-1");
    expect(runStatusLabel("waiting-approval")).toBe("Waiting for your approval");
    expect(runStatusLabel("uncertain")).toContain("check the result");
  });

  it("binds connection polling to a private verifier excluded from the browser URL", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          requestId: "request",
          verificationUrl: "https://bot.example.test/client/connect?requestId=request",
          userCode: "ABCD1234",
          expiresAt: Date.now() / 1000 + 300,
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, pending: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, ...session }));
    const client = new DotClient("https://bot.example.test", mock);
    const connection = await client.startConnection();
    expect(connection.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(connection.verificationUrl).not.toContain(connection.codeVerifier);
    const sent = JSON.parse(String(mock.mock.calls[0]?.[1]?.body));
    expect(sent.codeChallenge).toHaveLength(43);
    expect(sent.codeVerifier).toBeUndefined();
    expect(await client.pollConnection(connection)).toBeNull();
    expect(await client.pollConnection(connection)).toEqual(session);
    expect(JSON.parse(String(mock.mock.calls[1]?.[1]?.body)).codeVerifier).toBe(
      connection.codeVerifier,
    );
  });

  it("uses the loopback return only when the bot accepts it", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          requestId: "request",
          verificationUrl: "https://bot.example.test/client/connect?requestId=request",
          userCode: "ABCD1234",
          expiresAt: Date.now() / 1000 + 300,
          redirectUri: "http://127.0.0.1:53682/dot/callback",
        }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true, ...session }))
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          requestId: "legacy",
          verificationUrl: "https://bot.example.test/client/connect?requestId=legacy",
          userCode: "ABCD1234",
          expiresAt: Date.now() / 1000 + 300,
        }),
      );
    const client = new DotClient("https://bot.example.test", mock);
    const redirectUri = "http://127.0.0.1:53682/dot/callback";
    const connection = await client.startConnection(redirectUri);
    expect(connection.redirectUri).toBe(redirectUri);
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body)).redirectUri).toBe(redirectUri);
    expect(await client.pollConnection(connection, "return-code")).toEqual(session);
    expect(JSON.parse(String(mock.mock.calls[1]?.[1]?.body))).toEqual({
      requestId: "request",
      codeVerifier: connection.codeVerifier,
      returnCode: "return-code",
    });
    expect((await client.startConnection(redirectUri)).redirectUri).toBeUndefined();
  });

  it("expires sessions before dispatch, reports authentication failures, and sends boolean denials", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ok: false, error: "Expired owner session" }, { status: 401 }),
      )
      .mockResolvedValue(Response.json({ ok: true }));
    const client = new DotClient("https://bot.example.test", mock);
    await expect(client.state({ ...session, expiresAt: 1 })).rejects.toBeInstanceOf(DotApiError);
    expect(mock).not.toHaveBeenCalled();
    await expect(client.state(session)).rejects.toMatchObject({ status: 401 });
    await client.decide(session, "approval-1", false);
    expect(JSON.parse(String(mock.mock.calls[1]?.[1]?.body))).toEqual({ approved: false });
  });

  it("stores sessions per endpoint and clears them on disconnect", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    saveDotSession(storage, "https://bot.example.test", session);
    expect(readDotSession(storage, "https://bot.example.test")).toEqual(session);
    expect(readDotSession(storage, "https://another.example.test")).toBeNull();
    saveDotSession(storage, "https://bot.example.test", { ...session, expiresAt: 1 });
    expect(readDotSession(storage, "https://bot.example.test")).toBeNull();
    saveDotSession(storage, "https://bot.example.test", null);
    expect(values.size).toBe(0);
  });
});
