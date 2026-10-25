import {
  DEFAULT_VOICE_TRANSCRIPTION_LANGUAGE,
  DEFAULT_VOICE_TRANSCRIPTION_MODEL,
  type ServerVoiceTranscribeInput,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { detectVoiceSpeech } from "./voiceActivity";
import {
  encodeAudioBufferAsWav,
  isVoiceInputSilenceError,
  transcribeVoiceBlob,
} from "./voiceInput";

vi.mock("./voiceActivity", () => ({ detectVoiceSpeech: vi.fn() }));

const RATE = 16_000;

beforeEach(() => {
  vi.mocked(detectVoiceSpeech).mockImplementation(async (samples) => [
    { start: 0, end: samples.length },
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function ascii(arrayBuffer: ArrayBuffer, offset: number, length: number): string {
  return String.fromCharCode(...new Uint8Array(arrayBuffer, offset, length));
}

function fakeAudioBuffer(input: {
  readonly channels: readonly Float32Array<ArrayBuffer>[];
  readonly sampleRate: number;
}): Pick<AudioBuffer, "getChannelData" | "length" | "numberOfChannels" | "sampleRate"> {
  return {
    length: input.channels[0]?.length ?? 0,
    numberOfChannels: input.channels.length,
    sampleRate: input.sampleRate,
    getChannelData: (index: number) => input.channels[index] ?? new Float32Array(),
  };
}

function speechLikeSamples(): Float32Array<ArrayBuffer> {
  const samples = new Float32Array(RATE);
  for (let index = 2_000; index < 6_000; index += 1) {
    samples[index] = Math.sin(index / 8) * 0.08;
  }
  return samples;
}

/** Stands in for the browser decoding a recording into the 16 kHz context. */
function installDecodedRecording(...channels: Float32Array<ArrayBuffer>[]): void {
  const decoded = fakeAudioBuffer({ channels, sampleRate: RATE });
  class FakeOfflineAudioContext {
    decodeAudioData = vi.fn(async () => decoded);
  }
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
}

function decodeUploadedWav(input: ServerVoiceTranscribeInput | undefined) {
  const bytes = Uint8Array.from(atob(input?.audioBase64 ?? ""), (value) => value.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const sampleCount = view.getUint32(40, true) / 2;
  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    seconds: sampleCount / view.getUint32(24, true),
    sampleAt: (seconds: number) => view.getInt16(44 + Math.round(seconds * RATE) * 2, true),
  };
}

describe("encodeAudioBufferAsWav", () => {
  it("writes a PCM WAV header and interleaves stereo samples", () => {
    const left = new Float32Array([0, 1, -1]);
    const right = new Float32Array([0.5, -0.5, 0]);
    const wav = encodeAudioBufferAsWav(
      fakeAudioBuffer({
        channels: [left, right],
        sampleRate: 44_100,
      }),
    );
    const view = new DataView(wav);

    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16_383);
    expect(view.getInt16(48, true)).toBe(32_767);
    expect(view.getInt16(50, true)).toBe(-16_384);
    expect(view.getInt16(52, true)).toBe(-32_768);
    expect(view.getInt16(54, true)).toBe(0);
  });
});

describe("transcribeVoiceBlob", () => {
  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it("uploads speech on both sides of a long pause without the thirty-second gap", async () => {
    const samples = new Float32Array(34 * RATE);
    samples.fill(0.08, 1 * RATE, 2 * RATE);
    samples.fill(-0.08, 32 * RATE, 33 * RATE);
    installDecodedRecording(samples);
    vi.mocked(detectVoiceSpeech).mockResolvedValue([
      { start: 1 * RATE, end: 2 * RATE },
      { start: 32 * RATE, end: 33 * RATE },
    ]);
    let uploaded: ServerVoiceTranscribeInput | undefined;

    await transcribeVoiceBlob(new Blob(["recording"], { type: "audio/webm" }), async (input) => {
      uploaded = input;
      return { text: "Both sentences." };
    });

    expect(uploaded?.mimeType).toBe("audio/wav");
    const wav = decodeUploadedWav(uploaded);
    expect(wav).toMatchObject({ channels: 1, sampleRate: RATE, seconds: 4.7 });
    // The first sentence keeps its position; the second follows 0.7 s of retained padding.
    expect(wav.sampleAt(1.5)).toBeGreaterThan(2_000);
    expect(wav.sampleAt(3.2)).toBeLessThan(-2_000);
  });

  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it("mixes a stereo recording to mono before detecting speech", async () => {
    installDecodedRecording(new Float32Array(RATE).fill(0.2), new Float32Array(RATE).fill(0.1));
    let uploaded: ServerVoiceTranscribeInput | undefined;

    await transcribeVoiceBlob(new Blob(["voice"]), async (input) => {
      uploaded = input;
      return { text: "stereo" };
    });

    expect(vi.mocked(detectVoiceSpeech).mock.calls[0]?.[0][0]).toBeCloseTo(0.15);
    expect(decodeUploadedWav(uploaded)).toMatchObject({ channels: 1, seconds: 1 });
  });

  it("uses default transcription settings when no voice settings are supplied", async () => {
    installDecodedRecording(speechLikeSamples());
    let capturedInput: ServerVoiceTranscribeInput | undefined;

    const text = await transcribeVoiceBlob(
      new Blob(["voice"], { type: "audio/wav" }),
      async (input) => {
        capturedInput = input;
        return { text: "hello" };
      },
    );

    expect(text).toBe("hello");
    expect(capturedInput).toMatchObject({
      mimeType: "audio/wav",
      model: DEFAULT_VOICE_TRANSCRIPTION_MODEL,
      language: DEFAULT_VOICE_TRANSCRIPTION_LANGUAGE,
    });
    expect(capturedInput).not.toHaveProperty("baseUrl");
  });

  it("passes configured voice transcription settings to the server command", async () => {
    installDecodedRecording(speechLikeSamples());
    let capturedInput: ServerVoiceTranscribeInput | undefined;

    await transcribeVoiceBlob(
      new Blob(["voice"], { type: "audio/wav" }),
      async (input) => {
        capturedInput = input;
        return { text: "custom" };
      },
      {
        baseUrl: " https://voice-gateway.example.edu/v1 ",
        model: " api-cohere-transcribe-large ",
        language: " es ",
      },
    );

    expect(capturedInput).toMatchObject({
      baseUrl: "https://voice-gateway.example.edu/v1",
      mimeType: "audio/wav",
      model: "api-cohere-transcribe-large",
      language: "es",
    });
  });

  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it("rejects a muted recording without loading the speech detector", async () => {
    installDecodedRecording(new Float32Array(RATE));
    const transcribe = vi.fn();

    await expect(
      transcribeVoiceBlob(new Blob(["voice"], { type: "audio/wav" }), transcribe),
    ).rejects.toSatisfy(isVoiceInputSilenceError);
    expect(detectVoiceSpeech).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });

  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it("does not upload room noise when the speech detector finds no speech", async () => {
    installDecodedRecording(speechLikeSamples());
    vi.mocked(detectVoiceSpeech).mockResolvedValue([]);
    const transcribe = vi.fn();

    await expect(
      transcribeVoiceBlob(new Blob(["noise"], { type: "audio/mp4" }), transcribe),
    ).rejects.toSatisfy(isVoiceInputSilenceError);
    expect(transcribe).not.toHaveBeenCalled();
  });

  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it("uploads quiet speech the detector recognizes regardless of its overall volume", async () => {
    const samples = new Float32Array(10 * RATE);
    samples.fill(0.001, 1 * RATE, 2 * RATE);
    installDecodedRecording(samples);
    vi.mocked(detectVoiceSpeech).mockResolvedValue([{ start: 1 * RATE, end: 2 * RATE }]);
    const transcribe = vi.fn(async () => ({ text: "Quiet speech." }));

    await expect(
      transcribeVoiceBlob(new Blob(["voice"], { type: "audio/wav" }), transcribe),
    ).resolves.toBe("Quiet speech.");
    expect(transcribe).toHaveBeenCalledOnce();
  });

  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it("does not upload untreated audio if speech detection fails", async () => {
    installDecodedRecording(speechLikeSamples());
    const detectorError = new Error("no available backend found");
    vi.mocked(detectVoiceSpeech).mockRejectedValue(detectorError);
    const transcribe = vi.fn();

    await expect(
      transcribeVoiceBlob(new Blob(["voice"], { type: "audio/mp4" }), transcribe),
    ).rejects.toMatchObject({
      message: expect.stringContaining("the recording was not sent"),
      cause: detectorError,
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it("does not upload a recording canceled while speech detection was running", async () => {
    installDecodedRecording(speechLikeSamples());
    const abort = new AbortController();
    vi.mocked(detectVoiceSpeech).mockImplementation(async (_samples, signal) => {
      abort.abort();
      signal?.throwIfAborted();
      return [];
    });
    const transcribe = vi.fn();

    await expect(
      transcribeVoiceBlob(new Blob(["voice"]), transcribe, undefined, { signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transcribe).not.toHaveBeenCalled();
  });
});
