import { describe, expect, it } from "vite-plus/test";

import { compactVoicePauses, VOICE_SPEECH_SAMPLE_RATE as RATE } from "./voiceAudio";

const at = (seconds: number) => Math.round(seconds * RATE);

describe("compactVoicePauses", () => {
  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it("keeps both spoken sections and their quiet edges across a thirty-second pause", () => {
    const samples = new Float32Array(at(34));
    samples.fill(0.001, at(0.8), at(1));
    samples.fill(0.2, at(1), at(2));
    samples.fill(0.001, at(2), at(2.2));
    samples.fill(0.001, at(31.8), at(32));
    samples.fill(-0.2, at(32), at(33));
    samples.fill(0.001, at(33), at(33.2));

    const result = compactVoicePauses(samples, [
      { start: at(1), end: at(2) },
      { start: at(32), end: at(33) },
    ]);

    // The one-second lead and trail stay; the gap keeps 0.35 s of padding on each side.
    expect(result?.length).toBe(at(4.7));
    expect(result?.slice(0, at(2.35))).toEqual(samples.slice(0, at(2.35)));
    expect(result?.slice(at(2.35))).toEqual(samples.slice(at(31.65)));
  });

  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it("leaves ordinary pauses and short leading and trailing silence untouched", () => {
    const samples = new Float32Array(at(3));
    expect(
      compactVoicePauses(samples, [
        { start: at(0.2), end: at(0.8) },
        { start: at(2), end: at(2.8) },
      ]),
    ).toBe(samples);
  });

  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it("trims long leading and trailing silence while retaining padding", () => {
    const samples = Float32Array.from({ length: at(25) }, (_, index) => index / at(25));
    const result = compactVoicePauses(samples, [{ start: at(10), end: at(12) }]);
    expect(result).toEqual(samples.slice(at(9.65), at(12.35)));
  });

  // regression: #407 fix(web): shorten long dictation pauses before transcription
  it.each([
    { name: "fractional", speech: [{ start: 0.5, end: 100 }] },
    { name: "empty", speech: [{ start: 100, end: 100 }] },
    { name: "past the end", speech: [{ start: 0, end: RATE + 1 }] },
    {
      name: "overlapping",
      speech: [
        { start: 0, end: 200 },
        { start: 100, end: 300 },
      ],
    },
  ])("rejects $name detector boundaries", ({ speech }) => {
    expect(() => compactVoicePauses(new Float32Array(RATE), speech)).toThrow(
      "invalid audio boundaries",
    );
  });
});
