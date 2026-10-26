import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ApiKeyMcpFixtureProvider } from "./FixtureProviders.ts";

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

it("records synthetic writes only after host commit admission and a valid fixed destination", async () => {
  const secrets = memorySecrets();
  const provider = new ApiKeyMcpFixtureProvider(secrets.service);
  const flow = await provider.connect(["fixture.read"]);
  await provider.connect(["fixture.read"], undefined, {
    kind: "api_key",
    flowId: flow.flowId,
    value: "fixture-only-key",
  });
  const input = { destination: "synthetic-draft", content: "Synthetic final line" };
  await expect(provider.invoke("fixture.api-key.write", input)).rejects.toThrow("host approval");
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    writeApproved: true,
    beginCommit: async () => controller.signal,
  };
  let refused = 0;
  const beforeRefused = await provider.status();
  await expect(
    provider.invoke("fixture.api-key.write", input, {
      ...context,
      beginCommit: async () => {
        refused++;
        throw new Error("Commit refused");
      },
    }),
  ).rejects.toThrow("Commit refused");
  expect(refused).toBe(1);
  expect(await provider.status()).toEqual(beforeRefused);
  await expect(
    provider.invoke("fixture.api-key.write", { ...input, destination: "external" }, context),
  ).rejects.toBeDefined();
  expect(await provider.invoke("fixture.api-key.write", input, context)).toMatchObject({
    approvedWrites: 1,
  });
  expect((await provider.status()).message).toContain("Synthetic approved writes: 1");
  controller.abort();
  await expect(provider.invoke("fixture.api-key.write", input, context)).rejects.toThrow(
    "cancelled",
  );
  expect((await provider.status()).message).toContain("Synthetic approved writes: 1");
});
