import {
  DesktopTritonAiApiKeyReplaceResultSchema,
  type DesktopTritonAiApiKeyReplaceResult,
  UCSD_AI_BASE_URL_ENV,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopTritonAiApiKey from "../../settings/DesktopTritonAiApiKey.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const isInputError = Schema.is(DesktopTritonAiApiKey.DesktopTritonAiApiKeyInputError);
const isRejectedError = Schema.is(DesktopTritonAiApiKey.DesktopTritonAiApiKeyRejectedError);
const isValidationError = Schema.is(DesktopTritonAiApiKey.DesktopTritonAiApiKeyValidationError);
const isWriteError = Schema.is(DesktopTritonAiApiKey.DesktopTritonAiApiKeyWriteError);

function replacementFailureMessage(error: unknown): string {
  if (isInputError(error) || isRejectedError(error) || isValidationError(error)) {
    return error.message;
  }
  if (isWriteError(error)) {
    switch (error.operation) {
      case "create-directory":
        return "The key was verified, but its secure storage directory could not be created.";
      case "create-temporary-file-name":
        return "The key was verified, but a secure temporary file name could not be created.";
      case "write-temporary-file":
        return "The key was verified, but it could not be written to secure local storage.";
      case "replace-key-file":
        return "The key was verified, but the existing key file could not be replaced.";
    }
  }
  return "An unexpected desktop error prevented the API key from being saved.";
}

export const replaceTritonAiApiKey = makeIpcMethod({
  channel: IpcChannels.REPLACE_TRITONAI_API_KEY_CHANNEL,
  // Accept unknown here so schema diagnostics can never include a submitted
  // secret. The credential module performs value-independent validation.
  payload: Schema.Unknown,
  result: DesktopTritonAiApiKeyReplaceResultSchema,
  handler: Effect.fn("desktop.ipc.tritonAiApiKey.replace")(function* (rawApiKey) {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const result = yield* Effect.gen(function* () {
      const replacement = DesktopTritonAiApiKey.normalizeReplacementApiKey(rawApiKey);
      if (replacement === null) {
        return yield* new DesktopTritonAiApiKey.DesktopTritonAiApiKeyInputError();
      }
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const primary = yield* pool.primary;
      const currentConfig = yield* primary.currentConfig;
      if (Option.isNone(currentConfig)) {
        return yield* new DesktopTritonAiApiKey.DesktopTritonAiApiKeyValidationError({
          reason: "backend-not-ready",
        });
      }
      const baseUrl =
        currentConfig.value.env[UCSD_AI_BASE_URL_ENV] ??
        (currentConfig.value.extendEnv ? process.env[UCSD_AI_BASE_URL_ENV] : undefined);
      yield* DesktopTritonAiApiKey.validateTritonAiApiKey(replacement, { baseUrl });
      yield* DesktopTritonAiApiKey.replaceTritonAiApiKey(replacement);
    }).pipe(
      Effect.match({
        onFailure: (error) =>
          ({ status: "error", message: replacementFailureMessage(error) }) as const,
        onSuccess: () => ({ status: "saved" }) as const,
      }),
    );
    if (result.status === "error") return result;

    yield* lifecycle.relaunch("tritonai-api-key-replaced");
    return result satisfies DesktopTritonAiApiKeyReplaceResult;
  }),
});
