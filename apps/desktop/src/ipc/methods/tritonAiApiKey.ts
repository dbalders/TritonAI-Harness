import {
  DesktopTritonAiCredentialStatusSchema,
  DesktopTritonAiCredentialsUpdateResultSchema,
  type DesktopTritonAiCredentialRoute,
  type DesktopTritonAiCredentialsUpdateResult,
  UCSD_AI_BASE_URL_ENV,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopTritonAiApiKey from "../../settings/DesktopTritonAiApiKey.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const isInputError = Schema.is(DesktopTritonAiApiKey.DesktopTritonAiApiKeyInputError);
const isRejectedError = Schema.is(DesktopTritonAiApiKey.DesktopTritonAiApiKeyRejectedError);
const isValidationError = Schema.is(DesktopTritonAiApiKey.DesktopTritonAiApiKeyValidationError);
const isWriteError = Schema.is(DesktopTritonAiApiKey.DesktopTritonAiApiKeyWriteError);

function updateFailureMessage(error: unknown): string {
  if (isInputError(error) || isRejectedError(error) || isValidationError(error)) {
    return error.message;
  }
  if (isWriteError(error)) {
    switch (error.operation) {
      case "create-directory":
        return "The keys were verified, but their secure storage directory could not be created.";
      case "create-temporary-file-name":
        return "The keys were verified, but a secure temporary file name could not be created.";
      case "write-temporary-file":
        return "The keys were verified, but they could not be written to secure local storage.";
      case "replace-key-file":
        return "The keys were verified, but the existing credential file could not be replaced.";
    }
  }
  return "An unexpected desktop error prevented the access keys from being saved.";
}

function effectiveEnvironment(
  config: DesktopBackendManager.DesktopBackendStartConfig,
): Record<string, string | undefined> {
  return {
    ...(config.extendEnv ? process.env : {}),
    ...config.env,
  };
}

function readRouteCredentialUpdate(
  input: unknown,
): { readonly route: DesktopTritonAiCredentialRoute; readonly apiKey: string } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (record.route !== "on-prem" && record.route !== "frontier") return null;
  const apiKey = DesktopTritonAiApiKey.normalizeReplacementApiKey(record.apiKey);
  return apiKey === null ? null : { route: record.route, apiKey };
}

export const getTritonAiCredentialStatus = makeIpcMethod({
  channel: IpcChannels.GET_TRITONAI_CREDENTIAL_STATUS_CHANNEL,
  payload: Schema.Void,
  result: DesktopTritonAiCredentialStatusSchema,
  handler: Effect.fn("desktop.ipc.tritonAiCredentials.getStatus")(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const primary = yield* pool.primary;
    const currentConfig = yield* primary.currentConfig;
    if (Option.isSome(currentConfig)) {
      return DesktopTritonAiApiKey.credentialStatus(
        DesktopTritonAiApiKey.credentialBundleFromEnvironment(
          effectiveEnvironment(currentConfig.value),
        ),
      );
    }

    const override = yield* DesktopTritonAiApiKey.readTritonAiCredentialOverride;
    return DesktopTritonAiApiKey.credentialStatus(Option.getOrNull(override), false);
  }),
});

export const updateTritonAiCredentials = makeIpcMethod({
  channel: IpcChannels.UPDATE_TRITONAI_CREDENTIALS_CHANNEL,
  // Accept unknown so schema diagnostics can never include submitted secrets.
  payload: Schema.Unknown,
  result: DesktopTritonAiCredentialsUpdateResultSchema,
  handler: Effect.fn("desktop.ipc.tritonAiCredentials.update")(function* (rawApiKeys) {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const primary = yield* pool.primary;
    const result = yield* Effect.gen(function* () {
      const currentConfig = yield* primary.currentConfig;
      if (Option.isNone(currentConfig)) {
        return yield* new DesktopTritonAiApiKey.DesktopTritonAiApiKeyValidationError({
          reason: "backend-not-ready",
        });
      }
      const environment = effectiveEnvironment(currentConfig.value);
      const routeUpdate = readRouteCredentialUpdate(rawApiKeys);
      const replacement = yield* Array.isArray(rawApiKeys)
        ? DesktopTritonAiApiKey.validateAndAssignTritonAiCredentials(rawApiKeys, {
            baseUrl: environment[UCSD_AI_BASE_URL_ENV],
          })
        : Effect.gen(function* () {
            if (routeUpdate === null) {
              return yield* new DesktopTritonAiApiKey.DesktopTritonAiApiKeyInputError();
            }
            const access = yield* DesktopTritonAiApiKey.validateTritonAiApiKey(routeUpdate.apiKey, {
              baseUrl: environment[UCSD_AI_BASE_URL_ENV],
            });
            const routeReplacement = DesktopTritonAiApiKey.credentialUpdateForRoute(
              routeUpdate.apiKey,
              access,
              routeUpdate.route,
            );
            if (routeReplacement === null) {
              return yield* new DesktopTritonAiApiKey.DesktopTritonAiApiKeyValidationError({
                reason:
                  routeUpdate.route === "on-prem" ? "no-on-prem-access" : "no-frontier-access",
              });
            }
            return routeReplacement;
          });
      const credentials = DesktopTritonAiApiKey.mergeCredentialUpdate(
        DesktopTritonAiApiKey.credentialBundleFromEnvironment(environment),
        replacement,
      );
      yield* DesktopTritonAiApiKey.replaceTritonAiCredentials(credentials);
      return credentials;
    }).pipe(
      Effect.match({
        onFailure: (error) => ({ status: "error", message: updateFailureMessage(error) }) as const,
        onSuccess: (credentials) =>
          ({
            status: "saved",
            credentials: DesktopTritonAiApiKey.credentialStatus(credentials),
          }) as const,
      }),
    );
    if (result.status === "error") return result;

    // Keep the Electron shell open. Recreate only backend/provider children so
    // they inherit the new credential environment, then let the renderer reconnect.
    const backends = yield* pool.list;
    const restartableBackends = yield* Effect.forEach(backends, (backend) =>
      backend.snapshot.pipe(
        Effect.map((snapshot) => ({ backend, shouldRestart: snapshot.desiredRunning })),
      ),
    );
    yield* Effect.forEach(backends, (backend) => backend.stop(), { discard: true });
    yield* Effect.forEach(
      restartableBackends,
      ({ backend, shouldRestart }) => (shouldRestart ? backend.start : Effect.void),
      { discard: true },
    );
    return result satisfies DesktopTritonAiCredentialsUpdateResult;
  }),
});
