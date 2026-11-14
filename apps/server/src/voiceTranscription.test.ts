import { assert, describe, expect, it, vi } from "@effect/vitest";
import { DEFAULT_VOICE_TRANSCRIPTION_BASE_URL } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { transcribeVoice } from "./voiceTranscription.ts";

const audioBase64 = Buffer.from("voice bytes").toString("base64");

function makeInput(overrides: Partial<Parameters<typeof transcribeVoice>[0]> = {}) {
  return {
    audioBase64,
    mimeType: "audio/webm",
    ...overrides,
  };
}

describe("transcribeVoice", () => {
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
});
