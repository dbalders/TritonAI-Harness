import { describe, expect, it } from "vite-plus/test";

import { insertVoiceTranscript } from "./voiceInsertion";

describe("insertVoiceTranscript", () => {
  it.each([
    ["Summarize this", "and include risks", "Summarize this and include risks"],
    ["Summarize this ", "  and include risks  ", "Summarize this and include risks"],
    ["Summarize this\n", "and include risks", "Summarize this\nand include risks"],
    ["", "  New draft  ", "New draft"],
    ["Existing draft", "  ", "Existing draft"],
  ])("combines draft %j and transcript %j with normalized spacing", (value, transcript, text) => {
    expect(insertVoiceTranscript({ snapshot: { value }, transcript })).toEqual({
      text,
      cursor: text.length,
    });
  });
});
