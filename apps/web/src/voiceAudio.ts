export const VOICE_SPEECH_SAMPLE_RATE = 16_000;

/** Half-open sample range of detected speech in mono audio at `VOICE_SPEECH_SAMPLE_RATE`. */
export interface VoiceSpeechSegment {
  readonly start: number;
  readonly end: number;
}

const LONG_PAUSE_SAMPLES = 1.5 * VOICE_SPEECH_SAMPLE_RATE;
const SPEECH_PADDING_SAMPLES = Math.round(0.35 * VOICE_SPEECH_SAMPLE_RATE);

/**
 * Shortens non-speech spans longer than 1.5 seconds, keeping padding on both sides so word
 * edges survive. Shorter pauses are left untouched. Returns null when there is no speech.
 */
export function compactVoicePauses(
  samples: Float32Array<ArrayBuffer>,
  speech: readonly VoiceSpeechSegment[],
): Float32Array<ArrayBuffer> | null {
  if (speech.length === 0) return null;

  const kept: VoiceSpeechSegment[] = [];
  let keptStart = 0;
  let previousEnd: number | null = null;
  for (const segment of speech) {
    if (
      !Number.isInteger(segment.start) ||
      !Number.isInteger(segment.end) ||
      segment.start < (previousEnd ?? 0) ||
      segment.end <= segment.start ||
      segment.end > samples.length
    ) {
      throw new Error("Speech detection returned invalid audio boundaries.");
    }
    if (segment.start - (previousEnd ?? 0) > LONG_PAUSE_SAMPLES) {
      if (previousEnd !== null) {
        kept.push({ start: keptStart, end: previousEnd + SPEECH_PADDING_SAMPLES });
      }
      keptStart = segment.start - SPEECH_PADDING_SAMPLES;
    }
    previousEnd = segment.end;
  }
  const lastEnd = previousEnd ?? samples.length;
  const keptEnd =
    samples.length - lastEnd > LONG_PAUSE_SAMPLES
      ? lastEnd + SPEECH_PADDING_SAMPLES
      : samples.length;
  if (kept.length === 0 && keptStart === 0 && keptEnd === samples.length) return samples;
  kept.push({ start: keptStart, end: keptEnd });

  const output = new Float32Array(
    kept.reduce((total, range) => total + range.end - range.start, 0),
  );
  let offset = 0;
  for (const range of kept) {
    output.set(samples.subarray(range.start, range.end), offset);
    offset += range.end - range.start;
  }
  return output;
}
