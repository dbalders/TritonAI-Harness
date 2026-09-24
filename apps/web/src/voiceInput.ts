import {
  DEFAULT_VOICE_TRANSCRIPTION_BASE_URL,
  DEFAULT_VOICE_TRANSCRIPTION_LANGUAGE,
  DEFAULT_VOICE_TRANSCRIPTION_MODEL,
  type ServerVoiceTranscribeInput,
  type ServerVoiceTranscribeResult,
  type VoiceInputSettings,
} from "@t3tools/contracts";

const VOICE_RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/wav",
] as const;

const VOICE_TRANSCRIPTION_READY_MIME_TYPES = new Set([
  "audio/flac",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/mpga",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
]);

type AudioContextConstructor = typeof AudioContext;
type VoiceTranscriptionSettings = Pick<VoiceInputSettings, "baseUrl" | "model" | "language">;
export type VoiceTranscribe = (
  input: ServerVoiceTranscribeInput,
) => Promise<ServerVoiceTranscribeResult>;

const VOICE_SIGNAL_FRAME_SECONDS = 0.02;
const VOICE_ACTIVE_FRAME_RMS_AMPLITUDE = 0.006;
const MIN_VOICE_AUDIO_DURATION_SECONDS = 0.8;
const MIN_VOICE_PEAK_AMPLITUDE = 0.015;
const MIN_VOICE_RMS_AMPLITUDE = 0.002;
const MIN_VOICE_ACTIVE_DURATION_SECONDS = 0.22;
const VOICE_VOLUME_SAMPLE_INTERVAL_MS = 68;
const VOICE_VISUAL_NOISE_FLOOR_RMS = 0.0075;
const VOICE_VISUAL_NOISE_GATE_WIDTH_RMS = 0.006;
const VOICE_VISUAL_GAIN_RMS = 0.14;

export type VoiceVolumeListener = (level: number) => void;

export interface VoiceRecorderSession {
  readonly mimeType: string;
  readonly stop: () => Promise<Blob>;
  readonly cancel: () => void;
  readonly subscribeToVolume: (listener: VoiceVolumeListener) => () => void;
}

export interface VoiceAudioSignal {
  readonly durationSeconds: number;
  readonly peakAmplitude: number;
  readonly rmsAmplitude: number;
  readonly activeDurationSeconds: number;
}

class VoiceInputSilenceError extends Error {
  constructor() {
    super("No speech was detected.");
    this.name = "VoiceInputSilenceError";
  }
}

interface VoiceVolumeSampler {
  readonly subscribe: (listener: VoiceVolumeListener) => () => void;
  readonly close: () => void;
}

function resolveVoiceRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  return VOICE_RECORDING_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function resolveAudioContextConstructor(): AudioContextConstructor | undefined {
  return (
    globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext
  );
}

function voiceRmsToVisualLevel(rmsAmplitude: number): number {
  const gatedAmplitude = rmsAmplitude - VOICE_VISUAL_NOISE_FLOOR_RMS;
  if (gatedAmplitude <= 0) return 0;
  const gateOpacity = Math.min(1, gatedAmplitude / VOICE_VISUAL_NOISE_GATE_WIDTH_RMS);
  return Math.max(0, Math.min(1, Math.sqrt(gatedAmplitude / VOICE_VISUAL_GAIN_RMS) * gateOpacity));
}

function createVoiceVolumeSampler(stream: MediaStream): VoiceVolumeSampler | null {
  const AudioContextCtor = resolveAudioContextConstructor();
  if (
    !AudioContextCtor ||
    typeof globalThis.requestAnimationFrame !== "function" ||
    typeof globalThis.cancelAnimationFrame !== "function"
  ) {
    return null;
  }

  try {
    const audioContext = new AudioContextCtor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const samples = new Uint8Array(analyser.fftSize);
    const listeners = new Set<VoiceVolumeListener>();
    let frameId: number | null = null;
    let lastSampleAt = 0;
    let closed = false;

    const emitLevel = () => {
      analyser.getByteTimeDomainData(samples);
      let square = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        square += centered * centered;
      }
      const level = voiceRmsToVisualLevel(Math.sqrt(square / samples.length));
      for (const listener of listeners) {
        listener(level);
      }
    };

    const tick = (timestamp: number) => {
      if (closed || listeners.size === 0) {
        frameId = null;
        return;
      }
      if (timestamp - lastSampleAt >= VOICE_VOLUME_SAMPLE_INTERVAL_MS) {
        lastSampleAt = timestamp;
        emitLevel();
      }
      frameId = globalThis.requestAnimationFrame(tick);
    };

    const start = () => {
      if (frameId !== null || closed) return;
      void audioContext.resume?.().catch(() => undefined);
      frameId = globalThis.requestAnimationFrame(tick);
    };

    const stop = () => {
      if (frameId === null) return;
      globalThis.cancelAnimationFrame(frameId);
      frameId = null;
    };

    return {
      subscribe(listener) {
        if (closed) return () => undefined;
        listeners.add(listener);
        start();
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) {
            stop();
          }
        };
      },
      close() {
        if (closed) return;
        closed = true;
        stop();
        listeners.clear();
        try {
          source.disconnect();
        } catch {
          // The stream may already be torn down by the browser recorder.
        }
        try {
          analyser.disconnect();
        } catch {
          // The analyser can already be detached in browser cleanup paths.
        }
        void audioContext.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}

export async function createVoiceRecorder(): Promise<VoiceRecorderSession> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("Microphone recording is not available in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = resolveVoiceRecordingMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    stopMediaStream(stream);
    throw error;
  }
  const chunks: Blob[] = [];
  let stopped = false;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  const volumeSampler = createVoiceVolumeSampler(stream);
  const cleanup = () => {
    volumeSampler?.close();
    stopMediaStream(stream);
  };

  const stop = () =>
    new Promise<Blob>((resolve, reject) => {
      if (stopped) {
        reject(new Error("Voice recording has already stopped."));
        return;
      }
      stopped = true;
      recorder.addEventListener(
        "stop",
        () => {
          cleanup();
          resolve(
            new Blob(chunks.splice(0), { type: recorder.mimeType || mimeType || "audio/webm" }),
          );
        },
        { once: true },
      );
      recorder.addEventListener(
        "error",
        () => {
          cleanup();
          reject(new Error("Voice recording failed."));
        },
        { once: true },
      );
      try {
        recorder.stop();
      } catch (error) {
        chunks.splice(0);
        cleanup();
        reject(error);
      }
    });

  const cancel = () => {
    if (!stopped) {
      stopped = true;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // The stream is stopped below even if MediaRecorder cannot transition cleanly.
        }
      }
    }
    chunks.splice(0);
    cleanup();
  };

  try {
    recorder.start();
  } catch (error) {
    chunks.splice(0);
    cleanup();
    throw error;
  }

  return {
    mimeType: recorder.mimeType || mimeType || "audio/webm",
    stop,
    cancel,
    subscribeToVolume: volumeSampler?.subscribe ?? (() => () => undefined),
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function normalizedMimeType(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
}

function isTranscriptionReadyMimeType(mimeType: string): boolean {
  return VOICE_TRANSCRIPTION_READY_MIME_TYPES.has(normalizedMimeType(mimeType));
}

function trimmedVoiceSetting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function voiceBaseUrlOverride(
  settings: VoiceTranscriptionSettings | undefined,
): string | undefined {
  const baseUrl = trimmedVoiceSetting(settings?.baseUrl);
  if (!baseUrl || baseUrl === DEFAULT_VOICE_TRANSCRIPTION_BASE_URL) {
    return undefined;
  }
  return baseUrl;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function encodeAudioBufferAsWav(
  audioBuffer: Pick<AudioBuffer, "getChannelData" | "length" | "numberOfChannels" | "sampleRate">,
): ArrayBuffer {
  const channelCount = Math.max(1, Math.min(audioBuffer.numberOfChannels, 2));
  const sampleCount = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = sampleCount * blockAlign;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: channelCount }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
  let offset = 44;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channelIndex]?.[sampleIndex] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return output;
}

export function analyzeAudioBufferSignal(
  audioBuffer: Pick<AudioBuffer, "getChannelData" | "length" | "numberOfChannels" | "sampleRate">,
): VoiceAudioSignal {
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  const sampleCount = audioBuffer.length;
  const durationSeconds = sampleCount / audioBuffer.sampleRate;
  if (sampleCount <= 0 || audioBuffer.sampleRate <= 0) {
    return {
      durationSeconds: 0,
      peakAmplitude: 0,
      rmsAmplitude: 0,
      activeDurationSeconds: 0,
    };
  }

  const channels = Array.from({ length: channelCount }, (_, index) =>
    audioBuffer.getChannelData(index),
  );
  const frameSampleCount = Math.max(
    1,
    Math.round(audioBuffer.sampleRate * VOICE_SIGNAL_FRAME_SECONDS),
  );
  let peakAmplitude = 0;
  let totalSquare = 0;
  let totalSamples = 0;
  let activeDurationSeconds = 0;

  for (let frameStart = 0; frameStart < sampleCount; frameStart += frameSampleCount) {
    const frameEnd = Math.min(sampleCount, frameStart + frameSampleCount);
    let frameSquare = 0;
    let frameSamples = 0;

    for (let sampleIndex = frameStart; sampleIndex < frameEnd; sampleIndex += 1) {
      for (const channel of channels) {
        const sample = Math.max(-1, Math.min(1, channel[sampleIndex] ?? 0));
        const amplitude = Math.abs(sample);
        peakAmplitude = Math.max(peakAmplitude, amplitude);
        const square = sample * sample;
        totalSquare += square;
        totalSamples += 1;
        frameSquare += square;
        frameSamples += 1;
      }
    }

    const frameRms = frameSamples > 0 ? Math.sqrt(frameSquare / frameSamples) : 0;
    if (frameRms >= VOICE_ACTIVE_FRAME_RMS_AMPLITUDE) {
      activeDurationSeconds += (frameEnd - frameStart) / audioBuffer.sampleRate;
    }
  }

  return {
    durationSeconds,
    peakAmplitude,
    rmsAmplitude: totalSamples > 0 ? Math.sqrt(totalSquare / totalSamples) : 0,
    activeDurationSeconds,
  };
}

export function hasSpeechLikeSignal(signal: VoiceAudioSignal): boolean {
  return (
    signal.durationSeconds >= MIN_VOICE_AUDIO_DURATION_SECONDS &&
    signal.peakAmplitude >= MIN_VOICE_PEAK_AMPLITUDE &&
    signal.rmsAmplitude >= MIN_VOICE_RMS_AMPLITUDE &&
    signal.activeDurationSeconds >= MIN_VOICE_ACTIVE_DURATION_SECONDS
  );
}

function ensureVoiceSignalDetected(audioBuffer: AudioBuffer): void {
  if (!hasSpeechLikeSignal(analyzeAudioBufferSignal(audioBuffer))) {
    throw new VoiceInputSilenceError();
  }
}

export function isVoiceInputSilenceError(error: unknown): boolean {
  return error instanceof VoiceInputSilenceError;
}

async function decodeVoiceBlob(blob: Blob): Promise<AudioBuffer> {
  const AudioContextCtor = resolveAudioContextConstructor();
  if (!AudioContextCtor) {
    throw new Error("Voice recording format is not supported by this browser.");
  }

  const audioContext = new AudioContextCtor();
  try {
    return await audioContext.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void audioContext.close().catch(() => undefined);
  }
}

async function prepareVoiceBlobForTranscription(blob: Blob): Promise<Blob> {
  const audioBuffer = await decodeVoiceBlob(blob);
  ensureVoiceSignalDetected(audioBuffer);
  if (isTranscriptionReadyMimeType(blob.type)) {
    return blob;
  }
  return new Blob([encodeAudioBufferAsWav(audioBuffer)], { type: "audio/wav" });
}

export async function transcribeVoiceBlob(
  blob: Blob,
  transcribe: VoiceTranscribe,
  settings?: VoiceTranscriptionSettings,
): Promise<string> {
  const uploadBlob = await prepareVoiceBlobForTranscription(blob);
  const audioBase64 = await blobToBase64(uploadBlob);
  const baseUrl = voiceBaseUrlOverride(settings);
  const result = await transcribe({
    audioBase64,
    mimeType: uploadBlob.type || "audio/wav",
    ...(baseUrl ? { baseUrl } : {}),
    model: trimmedVoiceSetting(settings?.model) ?? DEFAULT_VOICE_TRANSCRIPTION_MODEL,
    language: trimmedVoiceSetting(settings?.language) ?? DEFAULT_VOICE_TRANSCRIPTION_LANGUAGE,
  });
  return result.text;
}

export function formatVoiceInputError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  return "Voice dictation failed. Try again.";
}
