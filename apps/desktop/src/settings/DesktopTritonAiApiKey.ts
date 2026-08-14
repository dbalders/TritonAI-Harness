import {
  DEFAULT_TRITONAI_AI_BASE_URL,
  TRITONAI_API_KEY_ENV,
  TRITONAI_FRONTIER_API_KEY_ENV,
  TRITONAI_ONPREM_API_KEY_ENV,
  type DesktopTritonAiCredentialStatus,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import managedConfig from "../../../../config/tritonai-managed-config.json" with { type: "json" };
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const MAX_API_KEY_LENGTH = 8_192;
const MAX_API_KEYS = 2;
const CREDENTIAL_BUNDLE_VERSION = 1;

const StoredCredentialBundle = Schema.Struct({
  version: Schema.Literal(CREDENTIAL_BUNDLE_VERSION),
  sharedApiKey: Schema.optionalKey(Schema.String),
  onPremApiKey: Schema.optionalKey(Schema.String),
  frontierApiKey: Schema.optionalKey(Schema.String),
});
const StoredCredentialBundleJson = Schema.fromJsonString(StoredCredentialBundle);
const decodeStoredCredentialBundle = Schema.decodeUnknownSync(StoredCredentialBundleJson);
const encodeStoredCredentialBundle = Schema.encodeSync(StoredCredentialBundleJson);

export interface TritonAiCredentialAccess {
  readonly onPrem: boolean;
  readonly frontier: boolean;
}

export interface TritonAiCredentialBundle {
  readonly sharedApiKey?: string;
  readonly onPremApiKey?: string;
  readonly frontierApiKey?: string;
}

interface ValidatedCredential {
  readonly key: string;
  readonly keyIndex: number;
  readonly access: TritonAiCredentialAccess;
}

const managedModelRoutes = new Map(
  managedConfig.models.catalog.map((model) => [model.id, model.route] as const),
);

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
    return "Enter one or two valid TritonAI access keys.";
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
    return "Could not securely save the TritonAI access keys.";
  }
}

export class DesktopTritonAiApiKeyRejectedError extends Schema.TaggedErrorClass<DesktopTritonAiApiKeyRejectedError>()(
  "DesktopTritonAiApiKeyRejectedError",
  { status: Schema.Int },
) {
  override get message(): string {
    return `TritonAI rejected the access key (HTTP ${this.status}).`;
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
  "no-model-access",
  "no-on-prem-access",
  "no-frontier-access",
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
        return "TritonAI returned an unexpected model list while verifying the key.";
      case "no-model-access":
        return "This key is active, but it does not include access to TritonAI Harness models.";
      case "no-on-prem-access":
        return "This key is active, but it does not include access to on-prem models.";
      case "no-frontier-access":
        return "This key is active, but it does not include access to frontier models.";
    }
  }
}

export function tritonAiApiKeyOverridePath(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): string {
  // Keep the established path so existing plain-text one-key overrides migrate in place.
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

export function normalizeReplacementApiKeys(raw: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_API_KEYS) return null;
  const normalized = raw.map(normalizeReplacementApiKey);
  if (normalized.some((apiKey) => apiKey === null)) return null;
  return [...new Set(normalized as ReadonlyArray<string>)];
}

export function normalizeCredentialBundle(
  input: TritonAiCredentialBundle,
): TritonAiCredentialBundle | null {
  const sharedApiKey = normalizeReplacementApiKey(input.sharedApiKey);
  if (sharedApiKey !== null) return { sharedApiKey };

  const onPremApiKey = normalizeReplacementApiKey(input.onPremApiKey);
  const frontierApiKey = normalizeReplacementApiKey(input.frontierApiKey);
  if (onPremApiKey === null && frontierApiKey === null) return null;
  return {
    ...(onPremApiKey === null ? {} : { onPremApiKey }),
    ...(frontierApiKey === null ? {} : { frontierApiKey }),
  };
}

export function credentialBundleFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): TritonAiCredentialBundle | null {
  const sharedApiKey = environment[TRITONAI_API_KEY_ENV];
  const onPremApiKey = environment[TRITONAI_ONPREM_API_KEY_ENV];
  const frontierApiKey = environment[TRITONAI_FRONTIER_API_KEY_ENV];
  return normalizeCredentialBundle({
    ...(sharedApiKey === undefined ? {} : { sharedApiKey }),
    ...(onPremApiKey === undefined ? {} : { onPremApiKey }),
    ...(frontierApiKey === undefined ? {} : { frontierApiKey }),
  });
}

export function credentialEnvironmentPatch(
  credentials: TritonAiCredentialBundle,
): Record<string, string | undefined> {
  const normalized = normalizeCredentialBundle(credentials);
  return {
    [TRITONAI_API_KEY_ENV]: normalized?.sharedApiKey,
    [TRITONAI_ONPREM_API_KEY_ENV]: normalized?.onPremApiKey,
    [TRITONAI_FRONTIER_API_KEY_ENV]: normalized?.frontierApiKey,
  };
}

export function credentialStatus(
  credentials: TritonAiCredentialBundle | null,
  ready = true,
): DesktopTritonAiCredentialStatus {
  const normalized = credentials === null ? null : normalizeCredentialBundle(credentials);
  const usesSharedKey = normalized?.sharedApiKey !== undefined;
  return {
    ready,
    usesSharedKey,
    onPremConfigured: usesSharedKey || normalized?.onPremApiKey !== undefined,
    frontierConfigured: usesSharedKey || normalized?.frontierApiKey !== undefined,
  };
}

function routeCredential(
  credentials: TritonAiCredentialBundle | null,
  route: "on-prem" | "frontier",
): string | undefined {
  if (credentials === null) return undefined;
  return route === "on-prem"
    ? (credentials.onPremApiKey ?? credentials.sharedApiKey)
    : (credentials.frontierApiKey ?? credentials.sharedApiKey);
}

export function mergeCredentialUpdate(
  existing: TritonAiCredentialBundle | null,
  replacement: TritonAiCredentialBundle,
): TritonAiCredentialBundle {
  if (replacement.sharedApiKey !== undefined) return replacement;
  const onPremApiKey = replacement.onPremApiKey ?? routeCredential(existing, "on-prem");
  const frontierApiKey = replacement.frontierApiKey ?? routeCredential(existing, "frontier");
  if (onPremApiKey !== undefined && onPremApiKey === frontierApiKey) {
    return { sharedApiKey: onPremApiKey };
  }
  return {
    ...(onPremApiKey === undefined ? {} : { onPremApiKey }),
    ...(frontierApiKey === undefined ? {} : { frontierApiKey }),
  };
}

export function credentialUpdateForRoute(
  apiKey: string,
  access: TritonAiCredentialAccess,
  route: "on-prem" | "frontier",
): TritonAiCredentialBundle | null {
  if (route === "on-prem") {
    return access.onPrem ? { onPremApiKey: apiKey } : null;
  }
  return access.frontier ? { frontierApiKey: apiKey } : null;
}

export function credentialBundleWithoutRoute(
  existing: TritonAiCredentialBundle | null,
  route: "on-prem" | "frontier",
): TritonAiCredentialBundle {
  const otherRoute = route === "on-prem" ? "frontier" : "on-prem";
  const otherApiKey = routeCredential(existing, otherRoute);
  if (otherApiKey === undefined) return {};
  return otherRoute === "on-prem" ? { onPremApiKey: otherApiKey } : { frontierApiKey: otherApiKey };
}

export function resolveTritonAiModelsEndpoint(
  configuredBaseUrl: string | undefined,
): string | null {
  try {
    const endpoint = new URL(configuredBaseUrl?.trim() || DEFAULT_TRITONAI_AI_BASE_URL);
    const isLoopback =
      endpoint.hostname === "localhost" ||
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]";
    if (endpoint.protocol !== "https:" && !isLoopback) return null;
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/models`;
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString();
  } catch {
    return null;
  }
}

function classifyModelAccess(payload: unknown): TritonAiCredentialAccess | null {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) return null;
  const data = payload.data;
  if (!Array.isArray(data)) return null;
  const access = { onPrem: false, frontier: false };
  for (const entry of data) {
    const modelId =
      typeof entry === "string"
        ? entry
        : typeof entry === "object" && entry !== null && "id" in entry
          ? entry.id
          : null;
    if (typeof modelId !== "string") continue;
    const route = managedModelRoutes.get(modelId);
    if (route === "on-prem") access.onPrem = true;
    if (route === "frontier") access.frontier = true;
  }
  return access;
}

export const validateTritonAiApiKey = Effect.fn("desktop.tritonAiApiKey.validate")(function* (
  apiKey: string,
  options: { readonly baseUrl: string | undefined },
): Effect.fn.Return<
  TritonAiCredentialAccess,
  DesktopTritonAiApiKeyRejectedError | DesktopTritonAiApiKeyValidationError,
  HttpClient.HttpClient
> {
  const httpClient = yield* HttpClient.HttpClient;
  const endpoint = resolveTritonAiModelsEndpoint(options.baseUrl);
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

  const payload = yield* response.json.pipe(
    Effect.mapError(() => new DesktopTritonAiApiKeyValidationError({ reason: "invalid-response" })),
  );
  const access = classifyModelAccess(payload);
  if (access === null) {
    return yield* new DesktopTritonAiApiKeyValidationError({ reason: "invalid-response" });
  }
  if (!access.onPrem && !access.frontier) {
    return yield* new DesktopTritonAiApiKeyValidationError({ reason: "no-model-access" });
  }
  return access;
});

export function assignValidatedCredentials(
  results: ReadonlyArray<ValidatedCredential>,
): TritonAiCredentialBundle | null {
  const onPremOnly = results.find((result) => result.access.onPrem && !result.access.frontier);
  const frontierOnly = results.find((result) => result.access.frontier && !result.access.onPrem);
  const onPrem = onPremOnly ?? results.find((result) => result.access.onPrem);
  const frontier =
    frontierOnly ?? [...results].toReversed().find((result) => result.access.frontier);
  if (onPrem === undefined && frontier === undefined) return null;
  if (onPrem !== undefined && frontier !== undefined && onPrem.key === frontier.key) {
    return { sharedApiKey: onPrem.key };
  }
  return {
    ...(onPrem === undefined ? {} : { onPremApiKey: onPrem.key }),
    ...(frontier === undefined ? {} : { frontierApiKey: frontier.key }),
  };
}

export const validateAndAssignTritonAiCredentials = Effect.fn(
  "desktop.tritonAiApiKey.validateAndAssign",
)(function* (
  rawApiKeys: unknown,
  options: { readonly baseUrl: string | undefined },
): Effect.fn.Return<
  TritonAiCredentialBundle,
  | DesktopTritonAiApiKeyInputError
  | DesktopTritonAiApiKeyRejectedError
  | DesktopTritonAiApiKeyValidationError,
  HttpClient.HttpClient
> {
  const apiKeys = normalizeReplacementApiKeys(rawApiKeys);
  if (apiKeys === null) return yield* new DesktopTritonAiApiKeyInputError();
  const results: ValidatedCredential[] = [];
  for (const [keyIndex, key] of apiKeys.entries()) {
    const access = yield* validateTritonAiApiKey(key, options);
    results.push({ key, keyIndex, access });
  }
  const credentials = assignValidatedCredentials(results);
  if (credentials === null) {
    return yield* new DesktopTritonAiApiKeyValidationError({ reason: "no-model-access" });
  }
  return credentials;
});

function parseStoredCredentialBundle(contents: string): TritonAiCredentialBundle | null {
  const trimmed = contents.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("{")) {
    const sharedApiKey = normalizeReplacementApiKey(trimmed);
    return sharedApiKey === null ? null : { sharedApiKey };
  }
  try {
    const parsed = decodeStoredCredentialBundle(trimmed, { onExcessProperty: "error" });
    return normalizeCredentialBundle(parsed) ?? {};
  } catch {
    return null;
  }
}

export const readTritonAiCredentialOverride = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const overridePath = tritonAiApiKeyOverridePath(environment);
  const contents = yield* fileSystem.readFileString(overridePath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.logWarning("Failed to read the TritonAI credential override file.").pipe(
              Effect.annotateLogs({
                component: "desktop-tritonai-api-key",
                path: overridePath,
                error: cause.message || String(cause),
              }),
              Effect.as(Option.none<string>()),
            ),
    }),
  );
  if (Option.isNone(contents)) return Option.none<TritonAiCredentialBundle>();
  const credentials = parseStoredCredentialBundle(contents.value);
  return credentials === null ? Option.none<TritonAiCredentialBundle>() : Option.some(credentials);
});

export const replaceTritonAiCredentials = Effect.fn("desktop.tritonAiApiKey.replaceCredentials")(
  function* (
    rawCredentials: TritonAiCredentialBundle,
    options?: { readonly allowEmpty?: boolean },
  ): Effect.fn.Return<
    void,
    DesktopTritonAiApiKeyInputError | DesktopTritonAiApiKeyWriteError,
    DesktopEnvironment.DesktopEnvironment | Crypto.Crypto | FileSystem.FileSystem
  > {
    const normalized = normalizeCredentialBundle(rawCredentials);
    if (normalized === null && !options?.allowEmpty) {
      return yield* new DesktopTritonAiApiKeyInputError();
    }
    const credentials = normalized ?? {};

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
    const serialized = `${encodeStoredCredentialBundle({
      version: CREDENTIAL_BUNDLE_VERSION,
      ...credentials,
    })}\n`;

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
      yield* fileSystem.writeFileString(tempPath, serialized, { flag: "wx", mode: 0o600 }).pipe(
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
  },
);

// Compatibility wrappers retain the old one-key storage API for migrations and focused callers.
export const readTritonAiApiKeyOverride = readTritonAiCredentialOverride.pipe(
  Effect.map(
    Option.map(
      (credentials) =>
        credentials.sharedApiKey ?? credentials.onPremApiKey ?? credentials.frontierApiKey ?? "",
    ),
  ),
);

export const replaceTritonAiApiKey = Effect.fn("desktop.tritonAiApiKey.replace")(function* (
  rawApiKey: unknown,
) {
  const sharedApiKey = normalizeReplacementApiKey(rawApiKey);
  if (sharedApiKey === null) return yield* new DesktopTritonAiApiKeyInputError();
  yield* replaceTritonAiCredentials({ sharedApiKey });
});
