import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fetchTritonAiUsage, TRITONAI_KEY_INFO_ENDPOINT } from "./tritonAiUsage.ts";

const validProviderResponse = {
  key: "raw-secret-key-value",
  info: {
    key_name: " sk-...LjnA ",
    key_alias: " dbalderston-free ",
    spend: 3.25,
    max_budget: 15,
    budget_duration: "30d",
    budget_reset_at: "2026-08-01T00:00:00+00:00",
    models: ["all-team-models", " all-team-models ", ""],
    tpm_limit: 25_000,
    rpm_limit: null,
    max_parallel_requests: 4,
    expires: null,
    last_active: "2026-07-08T12:30:00+00:00",
    soft_budget_cooldown: false,
    blocked: null,
    user_id: "internal-user-id",
    team_id: "internal-team-id",
    organization_id: "internal-organization-id",
  },
};

describe("fetchTritonAiUsage", () => {
  it.effect("fetches with the server key and returns only sanitized usage fields", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(
        async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          expect(url).toBe(TRITONAI_KEY_INFO_ENDPOINT);
          expect(init?.method).toBe("GET");
          expect(init?.headers).toEqual({
            Accept: "application/json",
            Authorization: "Bearer test-key",
          });
          return new Response(JSON.stringify(validProviderResponse), {
            headers: { "content-type": "application/json" },
          });
        },
      );

      const result = yield* fetchTritonAiUsage({
        env: { TRITONAI_API_KEY: " test-key " },
        fetch: fetchMock as unknown as typeof fetch,
        now: () => "2026-07-09T10:00:00.000Z",
      });

      assert.deepStrictEqual(result, {
        keyName: "sk-...LjnA",
        keyAlias: "dbalderston-free",
        spend: 3.25,
        maxBudget: 15,
        budgetDuration: "30d",
        budgetResetAt: "2026-08-01T00:00:00+00:00",
        models: ["all-team-models"],
        tpmLimit: 25_000,
        rpmLimit: null,
        maxParallelRequests: 4,
        expiresAt: null,
        lastActiveAt: "2026-07-08T12:30:00+00:00",
        softBudgetCooldown: false,
        blocked: null,
        fetchedAt: "2026-07-09T10:00:00.000Z",
      });
      expect(result).not.toHaveProperty("key");
      expect(result).not.toHaveProperty("user_id");
      expect(result).not.toHaveProperty("team_id");
      expect(result).not.toHaveProperty("organization_id");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("supports keys without a budget limit or optional metadata", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ info: { spend: 1.5 } })));

      const result = yield* fetchTritonAiUsage({
        env: { TRITONAI_API_KEY: "test-key" },
        fetch: fetchMock as unknown as typeof fetch,
      });

      assert.equal(result.spend, 1.5);
      assert.equal(result.maxBudget, null);
      assert.deepStrictEqual(result.models, []);
      assert.equal(result.budgetResetAt, null);
      assert.equal(result.rpmLimit, null);
    }),
  );

  it.effect("uses the configured TritonAI deployment origin for usage", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
        expect(url).toBe("https://tritonai.example.test/key/info");
        return new Response(JSON.stringify(validProviderResponse));
      });

      yield* fetchTritonAiUsage({
        env: {
          TRITONAI_API_KEY: "test-key",
          UCSD_AI_BASE_URL: "https://tritonai.example.test/custom/v1/?region=test",
        },
        fetch: fetchMock as unknown as typeof fetch,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("fails before fetch when the configured base URL is invalid", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();

      const error = yield* Effect.flip(
        fetchTritonAiUsage({
          env: {
            TRITONAI_API_KEY: "test-key",
            UCSD_AI_BASE_URL: "not a URL",
          },
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "invalid_base_url");
      assert.equal(error.recoverable, false);
      assert.match(error.message, /UCSD_AI_BASE_URL/u);
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("refuses to send the API key over plaintext to a remote host", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();

      const error = yield* Effect.flip(
        fetchTritonAiUsage({
          env: {
            TRITONAI_API_KEY: "test-key",
            UCSD_AI_BASE_URL: "http://tritonai.example.test/v1",
          },
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "invalid_base_url");
      assert.match(error.message, /HTTPS/u);
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("allows a plaintext loopback endpoint for local development", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
        expect(url).toBe("http://127.0.0.1:8080/key/info");
        return new Response(JSON.stringify(validProviderResponse));
      });

      yield* fetchTritonAiUsage({
        env: {
          TRITONAI_API_KEY: "test-key",
          UCSD_AI_BASE_URL: "http://127.0.0.1:8080/v1",
        },
        fetch: fetchMock as unknown as typeof fetch,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("fails before fetch when the server API key is missing", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();

      const error = yield* Effect.flip(
        fetchTritonAiUsage({
          env: {},
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "missing_api_key");
      assert.match(error.message, /TRITONAI_API_KEY/u);
      assert.equal(error.recoverable, true);
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("maps rejected credentials to an actionable error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        fetchTritonAiUsage({
          env: { TRITONAI_API_KEY: "bad-key" },
          fetch: vi.fn(
            async () => new Response("denied", { status: 401 }),
          ) as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "key_rejected");
      assert.equal(error.status, 401);
      assert.match(error.message, /Verify TRITONAI_API_KEY/u);
    }),
  );

  it.effect("rejects invalid JSON and malformed usage payloads", () =>
    Effect.gen(function* () {
      const invalidJsonError = yield* Effect.flip(
        fetchTritonAiUsage({
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: vi.fn(async () => new Response("not json")) as unknown as typeof fetch,
        }),
      );
      assert.equal(invalidJsonError.code, "invalid_response");
      assert.match(invalidJsonError.message, /unreadable/u);

      const malformedError = yield* Effect.flip(
        fetchTritonAiUsage({
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: vi.fn(
            async () =>
              new Response(JSON.stringify({ key: "must-not-leak", info: { spend: "unknown" } })),
          ) as unknown as typeof fetch,
        }),
      );
      assert.equal(malformedError.code, "invalid_response");
      assert.match(malformedError.message, /unexpected format/u);
    }),
  );

  it.effect("maps network failures without exposing provider details", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        fetchTritonAiUsage({
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: vi.fn(async () => {
            throw new Error("socket path contained sensitive diagnostic detail");
          }) as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "upstream_unavailable");
      expect(error.message).not.toMatch(/sensitive diagnostic detail/u);
    }),
  );

  it.effect("distinguishes upstream timeouts and rate limiting", () =>
    Effect.gen(function* () {
      const timeoutError = yield* Effect.flip(
        fetchTritonAiUsage({
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: vi.fn(async () => {
            throw new DOMException("timed out", "TimeoutError");
          }) as unknown as typeof fetch,
        }),
      );
      assert.equal(timeoutError.code, "upstream_timeout");

      const rateLimitError = yield* Effect.flip(
        fetchTritonAiUsage({
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: vi.fn(
            async () => new Response("rate limited", { status: 429 }),
          ) as unknown as typeof fetch,
        }),
      );
      assert.equal(rateLimitError.code, "upstream_rate_limited");
      assert.equal(rateLimitError.status, 429);
    }),
  );
});
