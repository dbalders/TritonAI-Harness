import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const DEFAULT_VOICE_TRANSCRIPTION_BASE_URL = "https://tritonai-api.ucsd.edu/v1";
export const DEFAULT_VOICE_TRANSCRIPTION_MODEL = "api-cohere-transcribe";
export const DEFAULT_VOICE_TRANSCRIPTION_LANGUAGE = "en";

export const VoiceInputProvider = Schema.Literals([
  "tritonai-litellm",
  "openai-compatible",
  "browser-native",
  "local-whisper",
]);
export type VoiceInputProvider = typeof VoiceInputProvider.Type;

export const VoiceCleanupMode = Schema.Literals(["off", "light"]);
export type VoiceCleanupMode = typeof VoiceCleanupMode.Type;

export const VoiceInputSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  provider: VoiceInputProvider.pipe(
    Schema.withDecodingDefault(Effect.succeed("tritonai-litellm" as const)),
  ),
  baseUrl: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_VOICE_TRANSCRIPTION_BASE_URL)),
  ),
  model: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_VOICE_TRANSCRIPTION_MODEL)),
  ),
  cleanupMode: VoiceCleanupMode.pipe(Schema.withDecodingDefault(Effect.succeed("off" as const))),
  language: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_VOICE_TRANSCRIPTION_LANGUAGE)),
  ),
  retainAudioForDebugging: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type VoiceInputSettings = typeof VoiceInputSettings.Type;

export const DEFAULT_VOICE_INPUT_SETTINGS: VoiceInputSettings = Schema.decodeSync(
  VoiceInputSettings,
)({});

export const VoiceInputSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  provider: Schema.optionalKey(VoiceInputProvider),
  baseUrl: Schema.optionalKey(TrimmedString),
  model: Schema.optionalKey(TrimmedString),
  cleanupMode: Schema.optionalKey(VoiceCleanupMode),
  language: Schema.optionalKey(TrimmedString),
  retainAudioForDebugging: Schema.optionalKey(Schema.Boolean),
});
export type VoiceInputSettingsPatch = typeof VoiceInputSettingsPatch.Type;

export const ServerVoiceTranscribeInput = Schema.Struct({
  audioBase64: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  baseUrl: Schema.optionalKey(TrimmedString),
  model: Schema.optionalKey(TrimmedString),
  language: Schema.optionalKey(TrimmedString),
});
export type ServerVoiceTranscribeInput = typeof ServerVoiceTranscribeInput.Type;

export const ServerVoiceTranscribeResult = Schema.Struct({
  text: Schema.String,
  usage: Schema.optionalKey(Schema.Unknown),
});
export type ServerVoiceTranscribeResult = typeof ServerVoiceTranscribeResult.Type;

export class ServerVoiceTranscriptionError extends Schema.TaggedError<ServerVoiceTranscriptionError>()(
  "ServerVoiceTranscriptionError",
  {
    code: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    recoverable: Schema.Boolean,
    status: Schema.optionalKey(Schema.Number),
  },
) {}
