import {
  DEFAULT_TRITONAI_AI_BASE_URL,
  ServerTritonAiUsageError,
  type ServerTritonAiUsageErrorCode,
  type ServerTritonAiUsageBudget,
  type ServerTritonAiUsageSnapshot,
  TRITONAI_API_KEY_ENV,
  UCSD_AI_BASE_URL_ENV,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const TRITONAI_KEY_INFO_ENDPOINT = "https://tritonai-api.ucsd.edu/key/info";

const USAGE_REQUEST_TIMEOUT_MS = 15_000;
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OptionalNullableString = Schema.optionalKey(Schema.NullOr(Schema.String));
const OptionalNullableNumber = Schema.optionalKey(Schema.NullOr(NonNegativeFinite));
const OptionalNullableInt = Schema.optionalKey(Schema.NullOr(NonNegativeInt));
const OptionalNullableBoolean = Schema.optionalKey(Schema.NullOr(Schema.Boolean));

const TritonAiKeyInfoResponse = Schema.Struct({
  info: Schema.Struct({
    key_name: OptionalNullableString,
    key_alias: OptionalNullableString,
    spend: NonNegativeFinite,
    max_budget: OptionalNullableNumber,
    budget_duration: OptionalNullableString,
    budget_reset_at: OptionalNullableString,
    models: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    tpm_limit: OptionalNullableInt,
    rpm_limit: OptionalNullableInt,
    max_parallel_requests: OptionalNullableInt,
    expires: OptionalNullableString,
    last_active: OptionalNullableString,
    soft_budget_cooldown: OptionalNullableBoolean,
    blocked: OptionalNullableBoolean,
  }),
});

const decodeTritonAiKeyInfoResponse = Schema.decodeUnknownEffect(TritonAiKeyInfoResponse);

interface TritonAiUsageEnv {
  readonly TRITONAI_API_KEY?: string | undefined;
  readonly UCSD_AI_BASE_URL?: string | undefined;
}

type FetchLike = typeof fetch;

function usageError(input: {
  readonly code: ServerTritonAiUsageErrorCode;
  readonly message: string;
  readonly recoverable?: boolean;
  readonly status?: number;
}): ServerTritonAiUsageError {
  return new ServerTritonAiUsageError({
    code: input.code,
    message: input.message,
    recoverable: input.recoverable ?? true,
    ...(input.status === undefined ? {} : { status: input.status }),
  });
}

function fetchFailure(cause: unknown): ServerTritonAiUsageError {
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return usageError({
      code: "upstream_timeout",
      message: "TritonAI did not respond in time. Check your connection and try again.",
    });
  }

  return usageError({
    code: "upstream_unavailable",
    message: "TritonAI usage could not be reached. Check your connection and try again.",
  });
}

function resolveKeyInfoEndpoint(
  env: TritonAiUsageEnv,
): Effect.Effect<string, ServerTritonAiUsageError> {
  const configuredBaseUrl = env.UCSD_AI_BASE_URL?.trim() || DEFAULT_TRITONAI_AI_BASE_URL;

  try {
    const endpoint = new URL("/key/info", configuredBaseUrl);
    const isLoopback =
      endpoint.hostname === "localhost" ||
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]";
    if (endpoint.protocol !== "https:" && !isLoopback) {
      return Effect.fail(
        usageError({
          code: "invalid_base_url",
          message:
            "Usage could not be loaded because UCSD_AI_BASE_URL must use HTTPS or a loopback host. Fix the app server configuration, restart it, and try again.",
          recoverable: false,
        }),
      );
    }

    return Effect.succeed(endpoint.toString());
  } catch {
    return Effect.fail(
      usageError({
        code: "invalid_base_url",
        message:
          "Usage could not be loaded because UCSD_AI_BASE_URL is not a valid URL. Fix the app server configuration, restart it, and try again.",
        recoverable: false,
      }),
    );
  }
}

function httpFailure(status: number): ServerTritonAiUsageError {
  if (status === 401 || status === 403) {
    return usageError({
      code: "key_rejected",
      message:
        "The configured TritonAI API key was rejected. Verify TRITONAI_API_KEY on the app server, restart it, and try again.",
      status,
    });
  }

  if (status === 429) {
    return usageError({
      code: "upstream_rate_limited",
      message: "TritonAI is temporarily rate limiting usage checks. Wait a moment and try again.",
      status,
    });
  }

  return usageError({
    code: "upstream_error",
    message: `TritonAI returned HTTP ${status} while loading usage. Try again in a moment.`,
    status,
  });
}

function optionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function sanitizeModels(models: ReadonlyArray<string> | null | undefined): ReadonlyArray<string> {
  const sanitized: string[] = [];
  const seen = new Set<string>();
  for (const model of models ?? []) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    sanitized.push(trimmed);
  }
  return sanitized;
}

function sanitizeBudget(info: {
  readonly max_budget?: number | null | undefined;
}): ServerTritonAiUsageBudget {
  if (!Object.hasOwn(info, "max_budget")) return { kind: "unreported" };
  if (info.max_budget === null || info.max_budget === undefined) return { kind: "unlimited" };
  return { kind: "limited", maxBudget: info.max_budget };
}

export const fetchTritonAiUsage = Effect.fn("fetchTritonAiUsage")(function* (options?: {
  readonly env?: TritonAiUsageEnv;
  readonly fetch?: FetchLike;
  readonly now?: () => string;
}): Effect.fn.Return<ServerTritonAiUsageSnapshot, ServerTritonAiUsageError> {
  const env =
    options?.env ??
    ({
      TRITONAI_API_KEY: process.env[TRITONAI_API_KEY_ENV],
      UCSD_AI_BASE_URL: process.env[UCSD_AI_BASE_URL_ENV],
    } satisfies TritonAiUsageEnv);
  const apiKey = env.TRITONAI_API_KEY?.trim();
  if (!apiKey) {
    return yield* usageError({
      code: "missing_api_key",
      message:
        "Usage is not configured. Set TRITONAI_API_KEY on the app server, restart it, and refresh this page.",
    });
  }

  const keyInfoEndpoint = yield* resolveKeyInfoEndpoint(env);

  const response = yield* Effect.tryPromise({
    try: () =>
      (options?.fetch ?? globalThis.fetch)(keyInfoEndpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      }),
    catch: fetchFailure,
  });

  if (!response.ok) {
    return yield* httpFailure(response.status);
  }

  const payload = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () =>
      usageError({
        code: "invalid_response",
        message: "TritonAI returned an unreadable usage response. Try again in a moment.",
      }),
  });

  const decoded = yield* decodeTritonAiKeyInfoResponse(payload).pipe(
    Effect.mapError(() =>
      usageError({
        code: "invalid_response",
        message: "TritonAI returned usage data in an unexpected format. Try again in a moment.",
      }),
    ),
  );

  const info = decoded.info;
  return {
    keyName: optionalText(info.key_name),
    keyAlias: optionalText(info.key_alias),
    spend: info.spend,
    budget: sanitizeBudget(info),
    budgetDuration: optionalText(info.budget_duration),
    budgetResetAt: optionalText(info.budget_reset_at),
    models: sanitizeModels(info.models),
    tpmLimit: info.tpm_limit ?? null,
    rpmLimit: info.rpm_limit ?? null,
    maxParallelRequests: info.max_parallel_requests ?? null,
    expiresAt: optionalText(info.expires),
    lastActiveAt: optionalText(info.last_active),
    softBudgetCooldown: info.soft_budget_cooldown ?? null,
    blocked: info.blocked ?? null,
    fetchedAt: options?.now ? options.now() : DateTime.formatIso(yield* DateTime.now),
  };
});
