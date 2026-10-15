// @effect-diagnostics globalFetch:off nodeBuiltinImport:off -- Exercises the real loopback listener as the browser would.
import * as NodeNet from "node:net";
import { expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import { listenForDotSignIn } from "./dotSignIn.ts";

const requestId = "r".repeat(43);
const code = "c".repeat(43);

it("accepts one loopback return and stops listening", async () => {
  const listener = await listenForDotSignIn();
  const redirect = new URL(listener.redirectUri);
  expect(redirect.hostname).toBe("127.0.0.1");
  expect(redirect.pathname).toBe("/dot/callback");
  expect((await fetch(`${redirect.origin}/other?requestId=${requestId}&code=${code}`)).status).toBe(
    404,
  );
  expect((await fetch(`${listener.redirectUri}?requestId=${requestId}&code=short`)).status).toBe(
    404,
  );
  const returned = await fetch(`${listener.redirectUri}?requestId=${requestId}&code=${code}`);
  expect(returned.status).toBe(200);
  expect(await returned.text()).toContain("return to TritonAI Harness");
  await expect(listener.result).resolves.toEqual({ requestId, code });
  await expect(fetch(listener.redirectUri)).rejects.toThrow();
});

it("resolves null when cancelled or expired", async () => {
  const cancelled = await listenForDotSignIn();
  cancelled.close();
  await expect(cancelled.result).resolves.toBeNull();
  const expired = await listenForDotSignIn(10);
  await expect(expired.result).resolves.toBeNull();
});

it("rejects malformed requests without failing", async () => {
  const listener = await listenForDotSignIn();
  const { port } = new URL(listener.redirectUri);
  const status = await new Promise<string>((resolve, reject) => {
    const socket = NodeNet.connect(Number(port), "127.0.0.1", () =>
      socket.write("GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
    );
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
  expect(status).toContain("400");
  listener.close();
  await expect(listener.result).resolves.toBeNull();
});

it("tells the app when the bot is not accepting new users", async () => {
  const listener = await listenForDotSignIn();
  expect((await fetch(`${listener.redirectUri}?requestId=short&error=signups_closed`)).status).toBe(
    404,
  );
  const returned = await fetch(
    `${listener.redirectUri}?requestId=${requestId}&error=signups_closed`,
  );
  expect(returned.status).toBe(200);
  expect(await returned.text()).toContain("isn't accepting new users");
  await expect(listener.result).resolves.toEqual({ requestId, error: "signups_closed" });
});
