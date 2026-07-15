import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { isIntegrationId } from "./manifest.ts";

const SAFE_SECRET_SUFFIX = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const MAX_SECRET_NAME_LENGTH = 200;

export class IntegrationSecretScopeError extends Error {
  constructor(integrationId: string) {
    super(`Secret names for ${integrationId} must stay within its integration namespace.`);
    this.name = "IntegrationSecretScopeError";
  }
}

export function scopeIntegrationSecretStore(
  store: ServerSecretStore.ServerSecretStore["Service"],
  integrationId: string,
  options: { readonly legacyNames?: Readonly<Record<string, string>> } = {},
): ServerSecretStore.ServerSecretStore["Service"] {
  if (!isIntegrationId(integrationId)) {
    throw new Error(`Invalid integration id ${integrationId}.`);
  }

  // The double delimiter cannot occur inside a valid integration id, so prefix-overlapping ids
  // such as `analytics` and `analytics-suite` can never address the same underlying secret.
  const prefix = `integration-${integrationId}--`;
  const legacyNames = new Map(Object.entries(options.legacyNames ?? {}));
  const claimedLegacyNames = new Set<string>();
  for (const [suffix, legacy] of legacyNames) {
    const canonical = `${prefix}${suffix}`;
    if (
      canonical.length > MAX_SECRET_NAME_LENGTH ||
      !SAFE_SECRET_SUFFIX.test(suffix) ||
      legacy.length > MAX_SECRET_NAME_LENGTH ||
      !SAFE_SECRET_SUFFIX.test(legacy) ||
      claimedLegacyNames.has(legacy)
    ) {
      throw new IntegrationSecretScopeError(integrationId);
    }
    claimedLegacyNames.add(legacy);
  }
  const scopedName = (
    suffix: string,
  ): Effect.Effect<{ readonly canonical: string; readonly legacy: string | null }> => {
    const canonical = `${prefix}${suffix}`;
    const legacy = legacyNames.get(suffix) ?? null;
    return canonical.length <= MAX_SECRET_NAME_LENGTH && SAFE_SECRET_SUFFIX.test(suffix)
      ? Effect.succeed({ canonical, legacy })
      : Effect.die(new IntegrationSecretScopeError(integrationId));
  };

  const get = (suffix: string) =>
    scopedName(suffix).pipe(
      Effect.flatMap(({ canonical, legacy }) =>
        store
          .get(canonical)
          .pipe(
            Effect.flatMap((value) =>
              Option.isSome(value) || legacy === null ? Effect.succeed(value) : store.get(legacy),
            ),
          ),
      ),
    );

  return {
    get,
    set: (suffix, value) =>
      scopedName(suffix).pipe(Effect.flatMap(({ canonical }) => store.set(canonical, value))),
    create: (suffix, value) =>
      scopedName(suffix).pipe(Effect.flatMap(({ canonical }) => store.create(canonical, value))),
    getOrCreateRandom: (suffix, bytes) =>
      get(suffix).pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              scopedName(suffix).pipe(
                Effect.flatMap(({ canonical }) => store.getOrCreateRandom(canonical, bytes)),
              ),
          }),
        ),
      ),
    remove: (suffix) =>
      scopedName(suffix).pipe(
        Effect.flatMap(({ canonical, legacy }) =>
          store
            .remove(canonical)
            .pipe(Effect.andThen(legacy === null ? Effect.void : store.remove(legacy))),
        ),
      ),
  };
}
