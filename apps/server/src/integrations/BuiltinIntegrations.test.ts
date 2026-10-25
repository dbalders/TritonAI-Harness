import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { loadBuiltinIntegrationPackagesForTest, loadBuiltinIntegrations } from "./builtins.ts";
import { makeFixtureIntegrations } from "./fixtureBuiltins.ts";

function memorySecrets() {
  const values = new Map<string, Uint8Array>();
  return {
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
}

describe("built-in integration packages", () => {
  it("keeps proof fixtures out of the default catalog", async () => {
    expect(await loadBuiltinIntegrations(memorySecrets())).toEqual([]);
  });

  it("closes constructed fixture providers without masking a production loading failure", async () => {
    const productionFailure = new Error("production loading failed");
    let closeCalls = 0;
    const fixtures = makeFixtureIntegrations(memorySecrets()).map((integration) =>
      integration.provider
        ? {
            ...integration,
            provider: {
              ...integration.provider,
              close: async () => {
                closeCalls += 1;
                throw new Error("fixture cleanup failed");
              },
            },
          }
        : integration,
    );

    await expect(
      loadBuiltinIntegrationPackagesForTest(
        async () => fixtures,
        async () => {
          throw productionFailure;
        },
      ),
    ).rejects.toBe(productionFailure);
    expect(closeCalls).toBe(1);
  });
});
