import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  IntegrationSecretScopeError,
  scopeIntegrationSecretStore,
} from "./IntegrationSecretStore.ts";

function memorySecrets() {
  const values = new Map<string, Uint8Array>();
  const service = {
    get: (name: string) =>
      Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
    set: (name: string, value: Uint8Array) =>
      Effect.sync(() => values.set(name, Uint8Array.from(value))).pipe(Effect.asVoid),
    create: (name: string, value: Uint8Array) =>
      Effect.sync(() => values.set(name, Uint8Array.from(value))).pipe(Effect.asVoid),
    getOrCreateRandom: (name: string, bytes: number) =>
      Effect.sync(() => {
        const value = values.get(name) ?? new Uint8Array(bytes);
        values.set(name, value);
        return Uint8Array.from(value);
      }),
    remove: (name: string) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"];
  return { service, values };
}

function expectScopeFailure<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(IntegrationSecretScopeError);
      }
    }),
  );
}

describe("integration secret store scopes", () => {
  it.effect("constructs canonical names from package ids and local suffixes", () =>
    Effect.gen(function* () {
      const secrets = memorySecrets();
      const analytics = scopeIntegrationSecretStore(secrets.service, "analytics-suite");
      const credential = new TextEncoder().encode("credential");

      yield* analytics.set("oauth", credential);

      expect(secrets.values.get("integration-analytics-suite--oauth")).toEqual(credential);
    }),
  );

  it.effect("keeps prefix-overlapping integration ids in distinct namespaces", () =>
    Effect.gen(function* () {
      const secrets = memorySecrets();
      const analyticsSuite = scopeIntegrationSecretStore(secrets.service, "analytics-suite");
      const analytics = scopeIntegrationSecretStore(secrets.service, "analytics");
      const suiteCredential = new TextEncoder().encode("suite-credential");
      const analyticsCredential = new TextEncoder().encode("analytics-credential");

      yield* analyticsSuite.set("oauth", suiteCredential);
      expect(Option.isNone(yield* analytics.get("suite-oauth"))).toBe(true);
      yield* analytics.set("suite-oauth", analyticsCredential);

      expect(secrets.values.get("integration-analytics-suite--oauth")).toEqual(suiteCredential);
      expect(secrets.values.get("integration-analytics--suite-oauth")).toEqual(analyticsCredential);
    }),
  );

  it.effect("reads and removes only host-declared legacy names", () =>
    Effect.gen(function* () {
      const secrets = memorySecrets();
      const legacyName = "integration-analytics-suite-oauth";
      const credential = new TextEncoder().encode("legacy-credential");
      secrets.values.set(legacyName, credential);
      const analytics = scopeIntegrationSecretStore(secrets.service, "analytics-suite", {
        legacyNames: { oauth: legacyName },
      });

      const stored = yield* analytics.get("oauth");
      expect(Option.isSome(stored) ? stored.value : null).toEqual(credential);
      yield* analytics.remove("oauth");
      expect(secrets.values.has(legacyName)).toBe(false);
    }),
  );

  it("rejects invalid or colliding legacy aliases when the scope is assembled", () => {
    const secrets = memorySecrets();
    expect(() =>
      scopeIntegrationSecretStore(secrets.service, "analytics-suite", {
        legacyNames: { oauth: "../other" },
      }),
    ).toThrow(IntegrationSecretScopeError);
    expect(() =>
      scopeIntegrationSecretStore(secrets.service, "analytics-suite", {
        legacyNames: { oauth: "legacy-oauth", calendar: "legacy-oauth" },
      }),
    ).toThrow(IntegrationSecretScopeError);
  });

  it.effect("rejects path-like names even inside the integration prefix", () =>
    Effect.gen(function* () {
      const secrets = memorySecrets();
      const analytics = scopeIntegrationSecretStore(secrets.service, "analytics-suite");

      yield* expectScopeFailure(analytics.get("../other"));
      expect(secrets.values.size).toBe(0);
    }),
  );
});
