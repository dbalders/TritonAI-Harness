import { assert, describe, expect, it, vi } from "@effect/vitest";
import { DEFAULT_VOICE_TRANSCRIPTION_BASE_URL } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { transcribeVoice } from "./voiceTranscription.ts";
import { TRITONAI_CLIENT_VERSION } from "./tritonAiClientHeaders.ts";

const audioBase64 = Buffer.from("voice bytes").toString("base64");

function makeInput(overrides: Partial<Parameters<typeof transcribeVoice>[0]> = {}) {
  return {
    audioBase64,
    mimeType: "audio/webm",
    ...overrides,
  };
}

describe("transcribeVoice", () => {
  it.effect("posts a multipart transcription request and returns provider text", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(
        async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          expect(_url).toBe("https://tritonai-api.ucsd.edu/v1/audio/transcriptions");
          expect(init?.method).toBe("POST");
          expect(init?.headers).toEqual({
            Authorization: "Bearer test-key",
            "X-TritonAI-Client": "harness",
            "X-TritonAI-Client-Version": TRITONAI_CLIENT_VERSION,
          });
          expect(init?.body).toBeInstanceOf(FormData);
          const form = init?.body as FormData;
          expect(form.get("model")).toBe("api-cohere-transcribe");
          expect(form.get("language")).toBe("en");
          expect(form.get("response_format")).toBe("json");
          expect(form.get("file")).toBeInstanceOf(Blob);
          return new Response(
            JSON.stringify({ text: "transcribed prompt", usage: { seconds: 5 } }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        },
      );

      const result = yield* transcribeVoice(makeInput(), {
        env: { TRITONAI_API_KEY: "test-key" },
        fetch: fetchMock as unknown as typeof fetch,
      });

      assert.deepStrictEqual(result, { text: "transcribed prompt", usage: { seconds: 5 } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("uses caller-provided endpoint only when it matches server config", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(
        async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          expect(_url).toBe("https://voice.example.test/v1/audio/transcriptions");
          const form = init?.body as FormData;
          expect(form.get("model")).toBe("custom-transcribe");
          expect(form.get("language")).toBe("es");
          return new Response(JSON.stringify({ text: "hola" }), {
            headers: { "content-type": "application/json" },
          });
        },
      );

      const result = yield* transcribeVoice(
        makeInput({
          baseUrl: "https://voice.example.test/v1/",
          model: "custom-transcribe",
          language: "es",
        }),
        {
          env: {
            TRITONAI_API_KEY: "test-key",
            UCSD_AI_BASE_URL: "https://voice.example.test/v1/",
          },
          fetch: fetchMock as unknown as typeof fetch,
        },
      );

      assert.deepStrictEqual(result, { text: "hola" });
    }),
  );

  it.effect("uses the server configured endpoint when the caller omits baseUrl", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async (_url: Parameters<typeof fetch>[0]) => {
        expect(_url).toBe("https://voice.example.test/v1/audio/transcriptions");
        return new Response(JSON.stringify({ text: "server configured" }), {
          headers: { "content-type": "application/json" },
        });
      });

      const result = yield* transcribeVoice(makeInput(), {
        env: {
          TRITONAI_API_KEY: "test-key",
          UCSD_AI_BASE_URL: "https://voice.example.test/v1/",
        },
        fetch: fetchMock as unknown as typeof fetch,
      });

      assert.deepStrictEqual(result, { text: "server configured" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("uses the recorded MIME type when naming multipart audio files", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(
        async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const form = init?.body as FormData;
          const file = form.get("file") as Blob & { readonly name?: string };
          expect(file).toBeInstanceOf(Blob);
          expect(file.type).toBe("audio/mp4");
          expect(file.name).toBe("voice-dictation.mp4");
          return new Response(JSON.stringify({ text: "mp4 transcript" }), {
            headers: { "content-type": "application/json" },
          });
        },
      );

      const result = yield* transcribeVoice(makeInput({ mimeType: "audio/mp4" }), {
        env: { TRITONAI_API_KEY: "test-key" },
        fetch: fetchMock as unknown as typeof fetch,
      });

      assert.deepStrictEqual(result, { text: "mp4 transcript" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("rejects the default endpoint when the server is configured for a custom one", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();

      const error = yield* Effect.flip(
        transcribeVoice(makeInput({ baseUrl: DEFAULT_VOICE_TRANSCRIPTION_BASE_URL }), {
          env: {
            TRITONAI_API_KEY: "test-key",
            UCSD_AI_BASE_URL: "https://voice.example.test/v1/",
          },
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "invalid_base_url");
      assert.match(error.message, /not allowed/u);
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects untrusted caller-provided endpoints before fetch", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();

      const error = yield* Effect.flip(
        transcribeVoice(makeInput({ baseUrl: "https://attacker.example.test/v1" }), {
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "invalid_base_url");
      assert.match(error.message, /not allowed/u);
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("fails before fetch when the server API key is missing", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();

      const error = yield* Effect.flip(
        transcribeVoice(makeInput(), {
          env: {},
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "missing_api_key");
      assert.equal(error.recoverable, true);
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects oversized encoded audio before decoding or fetch", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn();

      const error = yield* Effect.flip(
        transcribeVoice(makeInput({ audioBase64: "A".repeat(35_000_000) }), {
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "audio_too_large");
      assert.equal(error.recoverable, true);
      expect(fetchMock).not.toHaveBeenCalled();
    }),
  );

  it.effect("maps provider errors to recoverable transcription errors", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      });

      const error = yield* Effect.flip(
        transcribeVoice(makeInput(), {
          env: { TRITONAI_API_KEY: "test-key" },
          fetch: fetchMock as unknown as typeof fetch,
        }),
      );

      assert.equal(error.code, "provider_error");
      assert.match(error.message, /rate limited/u);
      assert.equal(error.recoverable, true);
      assert.equal(error.status, 429);
    }),
  );
});
