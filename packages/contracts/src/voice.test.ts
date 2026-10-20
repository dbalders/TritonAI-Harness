import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_VOICE_INPUT_SETTINGS } from "./voice.ts";

describe("voice input defaults", () => {
  it("enables server-backed voice dictation by default", () => {
    expect(DEFAULT_VOICE_INPUT_SETTINGS).toMatchObject({
      enabled: true,
      provider: "tritonai-litellm",
      model: "api-cohere-transcribe",
      language: "en",
    });
  });
});
