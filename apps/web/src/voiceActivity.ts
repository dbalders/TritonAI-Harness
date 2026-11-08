import sileroModelUrl from "@ricky0123/vad-web/dist/silero_vad_v5.onnx?url";
import { Silero } from "@ricky0123/vad-web/dist/models";
import * as ort from "onnxruntime-web/wasm";
// onnxruntime-web does not export its runtime files, so they are referenced by path.
import ortLoaderUrl from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url";
import ortWasmUrl from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";

import type { VoiceSpeechSegment } from "./voiceAudio";

const FRAME_SAMPLES = 512;
const SPEECH_PROBABILITY_THRESHOLD = 0.3;
const MAX_BLOCKING_MS = 16;

// The runtime ships with the client, so dictation never loads executable code from a CDN. No init
// timeout: onnxruntime remembers a failed init for the page, and a slow first download is not fatal.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { mjs: ortLoaderUrl, wasm: ortWasmUrl };

async function fetchSileroModel(signal: AbortSignal | undefined): Promise<ArrayBuffer> {
  const response = await fetch(sileroModelUrl, { signal: signal ?? null, cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Speech detection model request failed with status ${response.status}.`);
  }
  return response.arrayBuffer();
}

/**
 * Runs Silero VAD over mono 16 kHz samples and returns merged speech frames. Work is time-sliced
 * on the calling thread so the UI stays responsive and an abort takes effect between slices.
 * Slices yield through a message channel: timers are clamped and throttled in background tabs.
 */
export async function detectVoiceSpeech(
  samples: Float32Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<VoiceSpeechSegment[]> {
  const model = await Silero.new(ort, () => fetchSileroModel(signal));
  const channel = new MessageChannel();
  channel.port1.start();
  const yieldToBrowser = () =>
    new Promise<void>((resolve) => {
      channel.port1.addEventListener("message", () => resolve(), { once: true });
      channel.port2.postMessage(null);
    });
  return await (async () => {
    const speech: VoiceSpeechSegment[] = [];
    let sliceStartedAt = performance.now();
    for (let start = 0; start < samples.length; start += FRAME_SAMPLES) {
      signal?.throwIfAborted();
      const end = Math.min(samples.length, start + FRAME_SAMPLES);
      let frame = samples.subarray(start, end);
      if (frame.length < FRAME_SAMPLES) {
        frame = new Float32Array(FRAME_SAMPLES);
        frame.set(samples.subarray(start, end));
      }
      const { isSpeech } = await model.process(frame);
      if (isSpeech >= SPEECH_PROBABILITY_THRESHOLD) {
        const previous = speech.at(-1);
        if (previous?.end === start) {
          speech[speech.length - 1] = { start: previous.start, end };
        } else {
          speech.push({ start, end });
        }
      }
      if (performance.now() - sliceStartedAt >= MAX_BLOCKING_MS) {
        await yieldToBrowser();
        sliceStartedAt = performance.now();
      }
    }
    signal?.throwIfAborted();
    return speech;
  })().finally(async () => {
    channel.port1.close();
    await model.release();
  });
}
