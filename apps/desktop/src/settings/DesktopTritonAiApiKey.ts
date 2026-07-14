import { DEFAULT_TRITONAI_AI_BASE_URL } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const MAX_API_KEY_LENGTH = 8_192;

const DesktopTritonAiApiKeyWriteOperation = Schema.Literals([
  "create-directory",
  "create-temporary-file-name",
  "write-temporary-file",
  "replace-key-file",
]);

export class DesktopTritonAiApiKeyInputError extends Schema.TaggedErrorClass<DesktopTritonAiApiKeyInputError>()(
  "DesktopTritonAiApiKeyInputError",
  {},
) {
  override get message(): string {
    return "Enter a valid TritonAI API key.";
  }
}

export class DesktopTritonAiApiKeyWriteError extends Schema.TaggedErrorClass<DesktopTritonAiApiKeyWriteError>()(
  "DesktopTritonAiApiKeyWriteError",
  {
    operation: DesktopTritonAiApiKeyWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not securely save the replacement TritonAI API key.";
  }
}

export class DesktopTritonAiApiKeyRejectedError extends Schema.TaggedErrorClass<DesktopTritonAiApiKeyRejectedError>()(
  "DesktopTritonAiApiKeyRejectedError",
  { status: Schema.Int },
) {
  override get message(): string {
    return `TritonAI rejected the API key (HTTP ${this.status}).`;
  }
}

const DesktopTritonAiApiKeyValidationFailureReason = Schema.Literals([
  "backend-not-ready",
  "invalid-endpoint",
  "timeout",
  "unavailable",
  "rate-limited",
  "upstream-error",
  "invalid-response",
]);

export class DesktopTritonAiApiKeyValidationError extends Schema.TaggedErrorClass<DesktopTritonAiApiKeyValidationError>()(
  "DesktopTritonAiApiKeyValidationError",
  {
    reason: DesktopTritonAiApiKeyValidationFailureReason,
    status: Schema.optionalKey(Schema.Int),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "backend-not-ready":
        return "The local TritonAI backend is not ready yet. Wait for startup to finish and try again.";
      case "invalid-endpoint":
        return "The configured TritonAI endpoint is invalid or does not use HTTPS.";
      case "timeout":
        return "TritonAI did not respond within 15 seconds. Check your connection and try again.";
      case "unavailable":
        return "TritonAI could not be reached. Check your connection and try again.";
      case "rate-limited":
        return `TritonAI could not verify the key because it is rate limiting requests (HTTP ${this.status ?? 429}).`;
      case "upstream-error":
        return `TritonAI could not verify the key (HTTP ${this.status ?? "unknown"}).`;
      case "invalid-response":
        return "TritonAI returned an unexpected response while verifying the key.";
    }
  }
}

export function tritonAiApiKeyOverridePath(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): string {
  return environment.path.join(environment.stateDir, "secrets", "tritonai-api-key");
}

export function normalizeReplacementApiKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const apiKey = raw.trim();
  if (
    apiKey.length === 0 ||
    apiKey.length > MAX_API_KEY_LENGTH ||
    apiKey.includes("\0") ||
    apiKey.includes("\r") ||
    apiKey.includes("\n")
  ) {
    return null;
  }
  return apiKey;
}

export function resolveTritonAiKeyInfoEndpoint(
  configuredBaseUrl: string | undefined,
): string | null {
  try {
    const endpoint = new URL(
      "/key/info",
      configuredBaseUrl?.trim() || DEFAULT_TRITONAI_AI_BASE_URL,
    );
    const isLoopback =
      endpoint.hostname === "localhost" ||
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]";
    return endpoint.protocol === "https:" || isLoopback ? endpoint.toString() : null;
  } catch {
    return null;
  }
}

export const validateTritonAiApiKey = Effect.fn("desktop.tritonAiApiKey.validate")(function* (
  apiKey: string,
  options: { readonly baseUrl: string | undefined },
): Effect.fn.Return<
  void,
  DesktopTritonAiApiKeyRejectedError | DesktopTritonAiApiKeyValidationError,
  HttpClient.HttpClient
> {
  const httpClient = yield* HttpClient.HttpClient;
  const endpoint = resolveTritonAiKeyInfoEndpoint(options.baseUrl);
  if (endpoint === null) {
    return yield* new DesktopTritonAiApiKeyValidationError({ reason: "invalid-endpoint" });
  }

  const request = HttpClientRequest.get(endpoint).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
    HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
  );
  const response = yield* httpClient.execute(request).pipe(
    Effect.timeout("15 seconds"),
    Effect.mapError(
      (cause) =>
        new DesktopTritonAiApiKeyValidationError({
          reason:
            typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "TimeoutError"
              ? "timeout"
              : "unavailable",
        }),
    ),
  );

  if (response.status === 401 || response.status === 403) {
    return yield* new DesktopTritonAiApiKeyRejectedError({ status: response.status });
  }
  if (response.status === 429) {
    return yield* new DesktopTritonAiApiKeyValidationError({
      reason: "rate-limited",
      status: response.status,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new DesktopTritonAiApiKeyValidationError({
      reason: "upstream-error",
      status: response.status,
    });
  }

  // Consume the response before replacing the key so transport or response
  // failures also leave the existing override untouched.
  yield* response.json.pipe(
    Effect.mapError(() => new DesktopTritonAiApiKeyValidationError({ reason: "invalid-response" })),
    Effect.flatMap((payload) =>
      typeof payload === "object" && payload !== null && "info" in payload
        ? Effect.void
        : Effect.fail(new DesktopTritonAiApiKeyValidationError({ reason: "invalid-response" })),
    ),
  );
});

export const readTritonAiApiKeyOverride = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const overridePath = tritonAiApiKeyOverridePath(environment);

  const contents = yield* fileSystem.readFileString(overridePath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.logWarning("Failed to read the TritonAI API key override file.").pipe(
              Effect.annotateLogs({
                component: "desktop-tritonai-api-key",
                path: overridePath,
                error: cause.message || String(cause),
              }),
              Effect.as(Option.none<string>()),
            ),
    }),
  );
  if (Option.isNone(contents)) return Option.none<string>();

  const apiKey = contents.value.trim();
  return apiKey.length > 0 ? Option.some(apiKey) : Option.none<string>();
});

export const replaceTritonAiApiKey = Effect.fn("desktop.tritonAiApiKey.replace")(function* (
  rawApiKey: unknown,
): Effect.fn.Return<
  void,
  DesktopTritonAiApiKeyInputError | DesktopTritonAiApiKeyWriteError,
  DesktopEnvironment.DesktopEnvironment | Crypto.Crypto | FileSystem.FileSystem
> {
  const replacement = normalizeReplacementApiKey(rawApiKey);
  if (replacement === null) return yield* new DesktopTritonAiApiKeyInputError();

  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const overridePath = tritonAiApiKeyOverridePath(environment);
  const directory = environment.path.dirname(overridePath);
  const suffix = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new DesktopTritonAiApiKeyWriteError({
          operation: "create-temporary-file-name",
          path: overridePath,
          cause,
        }),
    ),
  );
  const tempPath = `${overridePath}.${process.pid}.${suffix}.tmp`;

  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopTritonAiApiKeyWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );

  yield* Effect.gen(function* () {
    yield* fileSystem
      .writeFileString(tempPath, `${replacement}\n`, { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.mapError(
          (cause) =>
            new DesktopTritonAiApiKeyWriteError({
              operation: "write-temporary-file",
              path: tempPath,
              cause,
            }),
        ),
      );
    yield* fileSystem.rename(tempPath, overridePath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopTritonAiApiKeyWriteError({
            operation: "replace-key-file",
            path: overridePath,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      fileSystem
        .remove(tempPath, { force: true })
        .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
    ),
  );
});
