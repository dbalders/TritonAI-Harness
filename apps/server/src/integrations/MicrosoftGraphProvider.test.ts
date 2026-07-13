// @effect-diagnostics globalDate:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { MICROSOFT_GRAPH_SECRET_NAME, MicrosoftGraphProvider } from "./MicrosoftGraphProvider.ts";

function memorySecrets() {
  const values = new Map<string, Uint8Array>();
  const service = {
    get: (name: string) =>
      Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
    set: (name: string, value: Uint8Array) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      }),
    create: (name: string, value: Uint8Array) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
    remove: (name: string) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"];
  return { service, values };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MicrosoftGraphProvider", () => {
  it("requests incremental read-only consent, persists only refresh credentials, and uses dedicated endpoints", async () => {
    const secrets = memorySecrets();
    const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const fetchImplementation = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      calls.push(init === undefined ? { url } : { url, init: init as RequestInit });
      if (url.endsWith("/devicecode")) {
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 900,
          interval: 1,
        });
      }
      if (url.endsWith("/token")) {
        return jsonResponse({
          access_token: "access-x",
          refresh_token: "refresh-x",
          expires_in: 3600,
          scope: "User.Read Mail.Read offline_access",
        });
      }
      if (url.includes("/me?$select=")) {
        return jsonResponse({ displayName: "Test User", mail: "test@example.edu" });
      }
      if (url.includes("/me/messages?")) return jsonResponse({ value: [] });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const provider = new MicrosoftGraphProvider(secrets.service, fetchImplementation);

    const flow = await provider.connect(["mail.read"]);
    const deviceBody = String(calls[0]?.init?.body);
    expect(deviceBody).toContain("Mail.Read");
    expect(deviceBody).not.toContain("Calendars.Read");
    await provider.poll(flow.flowId);

    const status = await provider.status();
    expect(status).toMatchObject({ state: "connected", grantedCapabilities: ["mail.read"] });
    expect(JSON.stringify(status)).not.toMatch(/access-x|refresh-x|device-secret/u);
    const persisted = new TextDecoder().decode(secrets.values.get(MICROSOFT_GRAPH_SECRET_NAME));
    expect(persisted).toContain("refresh-x");
    expect(persisted).not.toContain("access-x");

    await provider.invoke("microsoft365.mail.search", { query: "budget", limit: 5 });
    const graphCall = calls.find(({ url }) => url.includes("/me/messages?"));
    expect(graphCall?.url).toContain("%24top=5");
    expect(graphCall?.url).toContain("%24search=");
    expect(graphCall?.url).not.toContain("%24orderby=");
    expect(new Headers(graphCall?.init?.headers).get("authorization")).toBe("Bearer access-x");
    expect(calls.some(({ url }) => url.includes("calendar"))).toBe(false);

    await provider.disconnect();
    expect(secrets.values.has(MICROSOFT_GRAPH_SECRET_NAME)).toBe(false);
    expect((await provider.status()).state).toBe("not_connected");
  });

  it("persists a rotated refresh token before using the refreshed access token", async () => {
    const secrets = memorySecrets();
    const credential = {
      version: 1,
      refreshToken: "old-refresh",
      grantedScopes: ["Mail.Read"],
      accountLabel: "Test User",
      updatedAt: new Date(0).toISOString(),
    };
    secrets.values.set(
      MICROSOFT_GRAPH_SECRET_NAME,
      new TextEncoder().encode(JSON.stringify(credential)),
    );
    let graphObservedPersistedRotation = false;
    const fetchImplementation = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/token")) {
        return jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "User.Read Mail.Read offline_access",
        });
      }
      if (url.includes("/me/messages?")) {
        const stored = new TextDecoder().decode(secrets.values.get(MICROSOFT_GRAPH_SECRET_NAME));
        graphObservedPersistedRotation = stored.includes("new-refresh");
        return jsonResponse({ value: [] });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const provider = new MicrosoftGraphProvider(secrets.service, fetchImplementation);
    await provider.invoke("microsoft365.mail.search", {});
    expect(graphObservedPersistedRotation).toBe(true);
  });

  it("keeps a redeemed credential when optional profile enrichment fails", async () => {
    const secrets = memorySecrets();
    let tokenRedemptions = 0;
    const fetchImplementation = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) {
        return jsonResponse({
          device_code: "single-use-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://microsoft.test/device",
          expires_in: 900,
          interval: 1,
        });
      }
      if (url.endsWith("/token")) {
        tokenRedemptions += 1;
        return jsonResponse({
          access_token: "a1",
          refresh_token: "r1",
          expires_in: 3600,
          scope: "User.Read Mail.Read offline_access",
        });
      }
      if (url.includes("/me?$select=")) return jsonResponse({ error: "unavailable" }, 503);
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const provider = new MicrosoftGraphProvider(secrets.service, fetchImplementation);
    const flow = await provider.connect(["mail.read"]);

    await expect(provider.poll(flow.flowId)).resolves.toMatchObject({ state: "connected" });
    expect(tokenRedemptions).toBe(1);
    expect(await provider.status()).toMatchObject({
      state: "connected",
      accountLabel: null,
      grantedCapabilities: ["mail.read"],
    });
    const persisted = new TextDecoder().decode(secrets.values.get(MICROSOFT_GRAPH_SECRET_NAME));
    expect(persisted).toContain('"refreshToken":"r1"');
    await expect(provider.poll(flow.flowId)).rejects.toThrow(/not found/u);
    expect(tokenRedemptions).toBe(1);
  });

  it("does not restore credentials when disconnect overlaps token refresh", async () => {
    const secrets = memorySecrets();
    secrets.values.set(
      MICROSOFT_GRAPH_SECRET_NAME,
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          refreshToken: "old-refresh",
          grantedScopes: ["Mail.Read"],
          accountLabel: "Test User",
          updatedAt: new Date(0).toISOString(),
        }),
      ),
    );
    let releaseRefresh!: () => void;
    let markRefreshStarted!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const fetchImplementation = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/token")) {
        markRefreshStarted();
        await refreshGate;
        return jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "User.Read Mail.Read offline_access",
        });
      }
      if (url.includes("/me/messages?")) return jsonResponse({ value: [] });
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const provider = new MicrosoftGraphProvider(secrets.service, fetchImplementation);
    const invocation = provider.invoke("microsoft365.mail.search", {});
    await refreshStarted;
    const disconnecting = provider.disconnect();
    releaseRefresh();
    await invocation;
    await disconnecting;
    expect(secrets.values.has(MICROSOFT_GRAPH_SECRET_NAME)).toBe(false);
    expect((await provider.status()).state).toBe("not_connected");
  });

  it("invalidates older device-code flows when a newer connection starts", async () => {
    const secrets = memorySecrets();
    let deviceCode = 0;
    const fetchImplementation = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) {
        deviceCode += 1;
        return jsonResponse({
          device_code: `device-${deviceCode}`,
          user_code: `CODE-${deviceCode}`,
          verification_uri: "https://microsoft.test/device",
          expires_in: 900,
          interval: 1,
        });
      }
      if (url.endsWith("/token")) {
        return jsonResponse({ error: "authorization_pending" }, 400);
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const provider = new MicrosoftGraphProvider(secrets.service, fetchImplementation);
    const older = await provider.connect(["mail.read"]);
    const newer = await provider.connect(["calendar.read"]);
    await expect(provider.poll(older.flowId)).rejects.toThrow(/not found/u);
    expect(await provider.poll(newer.flowId)).toMatchObject({ state: "pending" });
  });

  it("preserves an active device-code flow when a replacement cannot start", async () => {
    const secrets = memorySecrets();
    let deviceRequests = 0;
    const fetchImplementation = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/devicecode")) {
        deviceRequests += 1;
        return deviceRequests === 1
          ? jsonResponse({
              device_code: "device-1",
              user_code: "CODE-1",
              verification_uri: "https://microsoft.test/device",
              expires_in: 900,
              interval: 1,
            })
          : jsonResponse({ error: "temporarily_unavailable" }, 503);
      }
      if (url.endsWith("/token")) {
        return jsonResponse({ error: "authorization_pending" }, 400);
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const provider = new MicrosoftGraphProvider(secrets.service, fetchImplementation);
    const active = await provider.connect(["mail.read"]);

    await expect(provider.connect(["calendar.read"])).rejects.toThrow(/could not start/u);
    await expect(provider.poll(active.flowId)).resolves.toMatchObject({ state: "pending" });
  });

  it("bounds Microsoft requests so lifecycle work cannot wait forever", async () => {
    const secrets = memorySecrets();
    let observedAbort = false;
    const fetchImplementation = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as typeof fetch;
    const provider = new MicrosoftGraphProvider(secrets.service, fetchImplementation, 5);

    await expect(provider.connect(["mail.read"])).rejects.toThrow(/timed out/u);
    expect(observedAbort).toBe(true);
    await expect(provider.disconnect()).resolves.toBeUndefined();
  });

  it("cancels token and Graph requests when registry access is revoked", async () => {
    const secrets = memorySecrets();
    secrets.values.set(
      MICROSOFT_GRAPH_SECRET_NAME,
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          refreshToken: "fake-r",
          grantedScopes: ["Mail.Read"],
          accountLabel: "Test User",
          updatedAt: new Date(0).toISOString(),
        }),
      ),
    );
    let observedAbort = false;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const fetchImplementation = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        markRequestStarted();
        signal?.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      })) as typeof fetch;
    const provider = new MicrosoftGraphProvider(secrets.service, fetchImplementation);
    const controller = new AbortController();

    const invocation = provider.invoke(
      "microsoft365.mail.search",
      {},
      { signal: controller.signal },
    );
    await requestStarted;
    controller.abort();

    await expect(invocation).rejects.toThrow(/cancelled/u);
    expect(observedAbort).toBe(true);
  });
});
