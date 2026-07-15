import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { API_KEY_FIXTURE_SECRET_NAME, ApiKeyMcpFixtureProvider } from "./FixtureProviders.ts";

function memorySecrets() {
  const values = new Map<string, Uint8Array>();
  const service = {
    get: (name: string) =>
      Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
    set: (name: string, value: Uint8Array) =>
      Effect.sync(() => values.set(name, Uint8Array.from(value))).pipe(Effect.asVoid),
    create: (name: string, value: Uint8Array) =>
      Effect.sync(() => values.set(name, Uint8Array.from(value))).pipe(Effect.asVoid),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
    remove: (name: string) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"];
  return { service, values };
}

describe("fixture integration providers", () => {
  it("accepts an API key into server-side storage while exposing a sanitized result", async () => {
    const secrets = memorySecrets();
    const provider = new ApiKeyMcpFixtureProvider(secrets.service);
    const flow = await provider.connect(["fixture.read"]);
    expect(flow.kind).toBe("api_key");
    const connected = await provider.connect(["fixture.read"], undefined, {
      kind: "api_key",
      flowId: flow.flowId,
      value: "fixture-user-supplied-key",
    });
    expect(connected.kind).toBe("connected");
    expect(new TextDecoder().decode(secrets.values.get(API_KEY_FIXTURE_SECRET_NAME))).toBe(
      "fixture-user-supplied-key",
    );

    const result = await provider.invoke("fixture.api-key.read", {});
    expect(result).toMatchObject({ authenticated: true, value: "api-key-fixture-ok" });
    expect(JSON.stringify({ flow, connected, result })).not.toContain("fixture-user-supplied-key");

    await provider.disconnect();
    expect(secrets.values.has(API_KEY_FIXTURE_SECRET_NAME)).toBe(false);
  });

  it("uses the bounded commit-tail signal for credential mutation", async () => {
    const secrets = memorySecrets();
    const blockingSecrets = {
      ...secrets.service,
      set: () => Effect.never,
    } as unknown as ServerSecretStore.ServerSecretStore["Service"];
    const provider = new ApiKeyMcpFixtureProvider(blockingSecrets);
    const flow = await provider.connect(["fixture.read"]);
    const lifecycle = new AbortController();
    const commit = new AbortController();

    const connecting = provider
      .connect(
        ["fixture.read"],
        {
          signal: lifecycle.signal,
          beginCommit: async () => commit.signal,
        },
        { kind: "api_key", flowId: flow.flowId, value: "fixture-key" },
      )
      .then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
    commit.abort();

    await expect(connecting).resolves.toBe("rejected");
    expect(secrets.values.has(API_KEY_FIXTURE_SECRET_NAME)).toBe(false);
  });
});
