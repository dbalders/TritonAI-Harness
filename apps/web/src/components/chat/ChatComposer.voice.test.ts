// @effect-diagnostics nodeBuiltinImport:off - Regression coverage verifies product wiring in the composer source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("ChatComposer voice dictation integration", () => {
  it("keeps recording, transcription, and composer controls connected", () => {
    const source = NodeFS.readFileSync(new URL("./ChatComposer.tsx", import.meta.url), "utf8");

    expect(source).toContain("serverEnvironment.transcribeVoice");
    expect(source).toContain("void createVoiceRecorder()");
    expect(source).toContain("await transcribeVoiceBlob(");
    expect(source).toContain("insertDraftTextIntoComposer(transcript)");
    expect(source.match(/<VoiceDictationControl/g)).toHaveLength(2);
    expect(source).toContain('data-testid="voice-dictation-button"');
  });
});
