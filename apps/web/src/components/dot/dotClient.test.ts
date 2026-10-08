import type { DotHandlingItem } from "./dotHandling";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  DotApiError,
  draftAfterSend,
  DotClient,
  isRateableRun,
  readDotSession,
  saveDotSession,
  runStatusLabel,
  type DotRun,
} from "./dotClient";

const session = {
  ownerToken: "synthetic-owner-session",
  expiresAt: Date.now() / 1000 + 3600,
  email: "owner@ucsd.edu",
};

describe("DotClient", () => {
  it("stops only the versioned owner item and reports a conflict's factual message", async () => {
    const item: DotHandlingItem = {
      kind: "reminder",
      id: "item/1",
      title: "Check report",
      state: "scheduled",
      version: "opaque-v2",
      controls: ["stop"],
    };
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          stopped: true,
          outcome: "stopped",
          kind: item.kind,
          id: item.id,
          message: "Reminder stopped.",
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            stopped: false,
            outcome: "conflict",
            message: "This item changed. Refresh before stopping it.",
          },
          { status: 409 },
        ),
      );
    const client = new DotClient("https://bot.example.test", mock);
    await expect(client.stopHandling(session, item)).resolves.toMatchObject({ stopped: true });
    expect(mock.mock.calls[0]?.[0]).toBe(
      "https://bot.example.test/handling/reminder/item%2F1/stop",
    );
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toEqual({
      expectedVersion: "opaque-v2",
    });
    expect(mock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${session.ownerToken}`,
    });
    await expect(client.stopHandling(session, item)).rejects.toMatchObject({
      status: 409,
      message: "This item changed. Refresh before stopping it.",
    });
  });

  it("requires a stable Run now request ID and uses the scheduled-prompt routes", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ ok: true, runId: "run1", status: "queued", duplicate: false }),
      );
    const client = new DotClient("https://bot.example.test", mock);
    expect(() => client.scheduledPromptAction(session, "sp_123456789abc", "run")).toThrow(
      "request ID",
    );
    expect(mock).not.toHaveBeenCalled();
    await client.scheduledPromptAction(session, "sp_123456789abc", "run", "click1");
    await client.scheduledPromptAction(session, "sp_123456789abc", "run", "click1");
    await client.scheduledPromptAction(session, "sp_123456789abc", "pause");
    await client.scheduledPromptAction(session, "sp_123456789abc", "resume");
    await client.scheduledPromptAction(session, "sp_123456789abc", "delete");
    await client.scheduledPromptAction(session, "sp_123456789abc", "opened");
    expect(mock.mock.calls.map(([url]) => url)).toEqual(
      ["run", "run", "pause", "resume", "delete", "opened"].map(
        (action) => `https://bot.example.test/scheduled-prompts/sp_123456789abc/${action}`,
      ),
    );
    expect(mock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { requestId: "click1" },
      { requestId: "click1" },
      {},
      {},
      {},
      {},
    ]);
    expect(
      mock.mock.calls.every(
        ([, init]) =>
          init?.method === "POST" &&
          new Headers(init.headers).get("Authorization") === `Bearer ${session.ownerToken}`,
      ),
    ).toBe(true);
  });

  it("fences pause controls when supported while accepting older snapshots", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ ok: true, paused: true }));
    const client = new DotClient("https://bot.example.test", mock);
    await client.pause(session, true, 4);
    await client.pause(session, false);
    expect(mock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { expectedControlVersion: 4 },
      {},
    ]);
    mock.mockResolvedValueOnce(
      Response.json({
        ok: true,
        user: { userId: "owner", email: "owner@example.test" },
        runs: [],
        tasks: [],
        approvals: [],
      }),
    );
    const state = await client.stateWithRunDetails(session);
    expect(state.runs).toEqual([]);
    expect(state.handling).toBeUndefined();
    expect(state.watches).toBeUndefined();
    expect(state.scheduledPrompts).toBeUndefined();
    expect(state.capabilities).toBeUndefined();
    expect(state.microsoft).toBeUndefined();
  });

  it("rates a proactive output with owner authentication and only sends reasons for not-useful", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ ok: true, changed: true, feedback: { outputId: "a", kind: "reminder" } }),
      );
    const client = new DotClient("https://bot.example.test", mock);
    await client.rate(session, "run/1", "not-useful", ["duplicate"]);
    await client.rate(session, "run/1", "useful", ["duplicate"]);
    expect(mock.mock.calls.map(([url]) => url)).toEqual([
      "https://bot.example.test/feedback/run%2F1",
      "https://bot.example.test/feedback/run%2F1",
    ]);
    expect(JSON.parse(String(mock.mock.calls[0]?.[1]?.body))).toEqual({
      rating: "not-useful",
      reasons: ["duplicate"],
    });
    expect(JSON.parse(String(mock.mock.calls[1]?.[1]?.body))).toEqual({ rating: "useful" });
    expect(mock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: `Bearer ${session.ownerToken}`,
      "Content-Type": "application/json",
    });
  });

  it("offers ratings only on finished proactive output", () => {
    const run = (kind: string, status = "completed", phase?: string) =>
      ({
        runId: "r",
        threadId: "dot",
        event: { kind, ...(phase ? { phase } : {}) },
        status,
        createdAt: "",
        updatedAt: "",
        result: { summary: "Output" },
      }) as Parameters<typeof isRateableRun>[0];
    expect(isRateableRun(run("attention"))).toBe(true);
    expect(isRateableRun(run("heartbeat", "failed"))).toBe(true);
    expect(isRateableRun(run("harness-update", "completed", "completed"))).toBe(true);
    expect(isRateableRun(run("harness-update", "completed", "running"))).toBe(false);
    expect(isRateableRun(run("message"))).toBe(false);
    expect(isRateableRun(run("today"))).toBe(false);
    expect(isRateableRun(run("meeting-prep", "queued"))).toBe(false);
  });

  const run = (runId: string, status: DotRun["status"]): DotRun => ({
    runId,
    status,
    threadId: "dot",
    event: { kind: "message" },
    createdAt: "2026-10-08T12:00:00Z",
    updatedAt: "2026-10-08T12:00:00Z",
  });

  it("polls active and newly accepted runs by GET, including completion between polls", async () => {
    const queued = run("queued", "queued");
    const approval = run("approval", "waiting-approval");
    const completed = run("completed", "completed");
    const finished = { ...queued, status: "completed", result: { summary: "Done" } };
    const mock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (url === "https://bot.example.test/state")
        return Response.json({ ok: true, runs: [queued, approval, completed] });
      const id = String(url).split("/").at(-1);
      return Response.json({
        ok: true,
        run: id === "queued" ? finished : id === "approval" ? approval : run("accepted", "running"),
      });
    });
    const state = await new DotClient("https://bot.example.test", mock).stateWithRunDetails(
      session,
      ["accepted", "queued", "completed"],
    );
    expect(state.runs).toEqual([finished, approval, completed, run("accepted", "running")]);
    expect(mock.mock.calls.map(([url]) => url)).toEqual([
      "https://bot.example.test/state",
      "https://bot.example.test/runs/queued",
      "https://bot.example.test/runs/approval",
      "https://bot.example.test/runs/accepted",
    ]);
    for (const [, init] of mock.mock.calls) {
      expect(init?.method).toBe("GET");
      expect(init?.headers).toEqual({ Authorization: `Bearer ${session.ownerToken}` });
    }
  });

  it("preserves durable waiting state but marks telemetry unavailable on a failed detail read", async () => {
    const approval = { ...run("approval", "waiting-approval"), activityFresh: true };
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, runs: [approval] }))
      .mockRejectedValueOnce(new TypeError("offline"));
    const state = await new DotClient("https://bot.example.test", mock).stateWithRunDetails(
      session,
    );
    expect(state.runs).toEqual([{ ...approval, activityFresh: false }]);
  });

  it("propagates an expired owner session during detail polling", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: true, runs: [run("active", "running")] }))
      .mockResolvedValueOnce(Response.json({ ok: false, error: "Sign in again" }, { status: 401 }));
    await expect(
      new DotClient("https://bot.example.test", mock).stateWithRunDetails(session),
    ).rejects.toMatchObject({ status: 401 });
  });

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
  it("reports a non-JSON gateway error as an unreachable bot and keeps its status", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    const failure = new DotClient("https://bot.example.test", fetchImpl as typeof fetch).state(
      session,
    );
    await expect(failure).rejects.toMatchObject({
      status: 502,
      message: "Could not reach your bot (502).",
    });
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

  it("signs out only the presenting desktop session with its owner token", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true, revoked: "session" }));
    await new DotClient("https://bot.example.test", mock).signOut(session);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe("https://bot.example.test/logout");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", body: "{}" });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${session.ownerToken}`);
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

describe("draftAfterSend", () => {
  it("clears what was sent and keeps only text typed while sending", () => {
    expect(draftAfterSend("hello", "hello")).toBe("");
    expect(draftAfterSend("hello world", "hello")).toBe("world");
    expect(draftAfterSend("goodbye", "hello")).toBe("goodbye");
  });
});
