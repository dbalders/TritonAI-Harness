import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  API_KEY_FIXTURE_SECRET_NAME,
  ApiKeyMcpFixtureProvider,
  SkillOnlyFixtureProvider,
} from "./FixtureProviders.ts";

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
  it("supports a connected skill-only provider with no tool surface", async () => {
    const provider = new SkillOnlyFixtureProvider();
    expect(provider.tools).toEqual([]);
    expect(await provider.status()).toMatchObject({
      state: "connected",
      grantedCapabilities: ["workflow.use"],
    });
  });

  it("keeps a fake API key server-side while exposing a sanitized tool result", async () => {
    const secrets = memorySecrets();
    const provider = new ApiKeyMcpFixtureProvider(secrets.service);
    const flow = await provider.connect(["fixture.read"]);
    const connected = await provider.poll(flow.flowId);
    expect(connected.state).toBe("connected");
    expect(secrets.values.has(API_KEY_FIXTURE_SECRET_NAME)).toBe(true);

    const result = await provider.invoke("fixture.api-key.read", {});
    expect(result).toMatchObject({ authenticated: true, value: "api-key-fixture-ok" });
    expect(JSON.stringify({ flow, connected, result })).not.toContain(
      "fixture-server-side-api-key",
    );

    await provider.disconnect();
    expect(secrets.values.has(API_KEY_FIXTURE_SECRET_NAME)).toBe(false);
  });
});
