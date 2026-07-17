import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_VOICE_TRANSCRIPTION_BASE_URL,
  DEFAULT_VOICE_TRANSCRIPTION_LANGUAGE,
  DEFAULT_VOICE_TRANSCRIPTION_MODEL,
  ServerVoiceTranscriptionError,
  type ServerVoiceTranscribeInput,
  type ServerVoiceTranscribeResult,
} from "@t3tools/contracts";
import { makeTritonAiClientHeaders } from "./tritonAiClientHeaders.ts";

const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_VOICE_AUDIO_BASE64_CHARS = Math.ceil(MAX_VOICE_AUDIO_BYTES / 3) * 4;
const TRANSCRIPTION_TIMEOUT_MS = 60_000;

interface VoiceTranscriptionEnv {
  readonly TRITONAI_API_KEY?: string | undefined;
  readonly UCSD_AI_BASE_URL?: string | undefined;
}

interface TranscriptionConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly language: string;
  readonly apiKey: string;
}

type FetchLike = typeof fetch;
const isServerVoiceTranscriptionError = Schema.is(ServerVoiceTranscriptionError);

function voiceError(input: {
  readonly code: string;
  readonly message: string;
  readonly recoverable?: boolean;
  readonly status?: number;
}): ServerVoiceTranscriptionError {
  return new ServerVoiceTranscriptionError({
    code: input.code,
    message: input.message,
    recoverable: input.recoverable ?? true,
    ...(input.status === undefined ? {} : { status: input.status }),
  });
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function configuredBaseUrl(env: VoiceTranscriptionEnv): string {
  return trimTrailingSlash(env.UCSD_AI_BASE_URL?.trim() || DEFAULT_VOICE_TRANSCRIPTION_BASE_URL);
}

function validateTrustedBaseUrl(
  baseUrl: string,
): Effect.Effect<void, ServerVoiceTranscriptionError> {
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "https:" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1"
    ) {
      return Effect.fail(
        voiceError({
          code: "invalid_base_url",
          message: "Voice transcription endpoint must use HTTPS or localhost.",
        }),
      );
    }
  } catch {
    return Effect.fail(
      voiceError({
        code: "invalid_base_url",
        message: "Voice transcription endpoint is not a valid URL.",
      }),
    );
  }

  return Effect.void;
}

function resolveTrustedBaseUrl(
  input: ServerVoiceTranscribeInput,
  env: VoiceTranscriptionEnv,
): Effect.Effect<string, ServerVoiceTranscriptionError> {
  const serverBaseUrl = configuredBaseUrl(env);
  const trustedBaseUrls = new Set([trimTrailingSlash(serverBaseUrl)]);
  const requestedBaseUrl = trimTrailingSlash(input.baseUrl?.trim() || serverBaseUrl);

  if (!trustedBaseUrls.has(requestedBaseUrl)) {
    return Effect.fail(
      voiceError({
        code: "invalid_base_url",
        message: "Voice transcription endpoint is not allowed by this server.",
      }),
    );
  }

  return validateTrustedBaseUrl(requestedBaseUrl).pipe(Effect.as(requestedBaseUrl));
}

function resolveVoiceTranscriptionConfig(
  input: ServerVoiceTranscribeInput,
  env: VoiceTranscriptionEnv,
): Effect.Effect<TranscriptionConfig, ServerVoiceTranscriptionError> {
  const apiKey = env.TRITONAI_API_KEY?.trim();
  if (!apiKey) {
    return Effect.fail(
      voiceError({
        code: "missing_api_key",
        message: "Voice transcription is not configured. Set TRITONAI_API_KEY on the app server.",
      }),
    );
  }

  return Effect.gen(function* () {
    const baseUrl = yield* resolveTrustedBaseUrl(input, env);

    return {
      apiKey,
      baseUrl,
      model: input.model?.trim() || DEFAULT_VOICE_TRANSCRIPTION_MODEL,
      language: input.language?.trim() || DEFAULT_VOICE_TRANSCRIPTION_LANGUAGE,
    };
  });
}

function decodeAudioBase64(
  input: ServerVoiceTranscribeInput,
): Effect.Effect<Buffer, ServerVoiceTranscriptionError> {
  if (input.audioBase64.length > MAX_VOICE_AUDIO_BASE64_CHARS) {
    return Effect.fail(
      voiceError({
        code: "audio_too_large",
        message: "Recorded audio is too large. Try a shorter dictation.",
      }),
    );
  }

  const normalized = input.audioBase64.replace(/\s+/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 === 1) {
    return Effect.fail(
      voiceError({
        code: "invalid_audio",
        message: "Recorded audio payload was not valid base64.",
      }),
    );
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) {
    return Effect.fail(
      voiceError({
        code: "invalid_audio",
        message: "Recorded audio was empty.",
      }),
    );
  }
  if (buffer.length > MAX_VOICE_AUDIO_BYTES) {
    return Effect.fail(
      voiceError({
        code: "audio_too_large",
        message: "Recorded audio is too large. Try a shorter dictation.",
      }),
    );
  }
  return Effect.succeed(buffer);
}

function transcriptionEndpoint(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/audio/transcriptions`;
}

function audioFilenameExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim();
  switch (normalized) {
    case "audio/webm":
      return "webm";
    case "audio/mp4":
      return "mp4";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    default:
      return "webm";
  }
}

function safeProviderDetail(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Provider returned an empty error response.";
  return trimmed.length > 700 ? `${trimmed.slice(0, 700)}...` : trimmed;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json().catch(() => null);
  }
  return await response.text().catch(() => "");
}

function extractTranscriptText(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (payload && typeof payload === "object") {
    const candidate = (payload as { text?: unknown }).text;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

function extractErrorMessage(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return safeProviderDetail(message);
    }
    const message = record.message;
    if (typeof message === "string") return safeProviderDetail(message);
  }
  if (typeof payload === "string") {
    return safeProviderDetail(payload);
  }
  return "Provider returned an unsupported error response.";
}

export function transcribeVoice(
  input: ServerVoiceTranscribeInput,
  options?: {
    readonly env?: VoiceTranscriptionEnv;
    readonly fetch?: FetchLike;
  },
): Effect.Effect<ServerVoiceTranscribeResult, ServerVoiceTranscriptionError> {
  return Effect.gen(function* () {
    const env =
      options?.env ??
      ({
        TRITONAI_API_KEY: process.env.TRITONAI_API_KEY,
        UCSD_AI_BASE_URL: process.env.UCSD_AI_BASE_URL,
      } satisfies VoiceTranscriptionEnv);
    const fetchImpl = options?.fetch ?? globalThis.fetch;
    const config = yield* resolveVoiceTranscriptionConfig(input, env);
    const audioBuffer = yield* decodeAudioBase64(input);

    return yield* Effect.tryPromise({
      try: async () => {
        const form = new FormData();
        form.set("model", config.model);
        form.set("language", config.language);
        form.set("response_format", "json");
        form.set(
          "file",
          new Blob([audioBuffer], { type: input.mimeType }),
          `voice-dictation.${audioFilenameExtension(input.mimeType)}`,
        );

        const response = await fetchImpl(transcriptionEndpoint(config.baseUrl), {
          method: "POST",
          headers: {
            ...makeTritonAiClientHeaders(),
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: form,
          signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
        });

        const payload = await readResponsePayload(response);
        if (!response.ok) {
          throw voiceError({
            code: "provider_error",
            message: `Voice transcription failed: ${extractErrorMessage(payload)}`,
            status: response.status,
          });
        }

        const text = extractTranscriptText(payload);
        if (!text) {
          throw voiceError({
            code: "empty_transcript",
            message: "Voice transcription returned no text.",
          });
        }

        return {
          text,
          ...(payload && typeof payload === "object" && "usage" in payload
            ? { usage: (payload as { usage?: unknown }).usage }
            : {}),
        };
      },
      catch: (cause) => {
        if (isServerVoiceTranscriptionError(cause)) return cause;
        if (cause instanceof DOMException && cause.name === "TimeoutError") {
          return voiceError({
            code: "provider_timeout",
            message: "Voice transcription timed out. Try again with a shorter clip.",
          });
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        return voiceError({
          code: "provider_unavailable",
          message: `Voice transcription is unavailable: ${safeProviderDetail(message)}`,
        });
      },
    });
  });
}
