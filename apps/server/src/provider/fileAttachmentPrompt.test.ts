import { describe, expect, it } from "vite-plus/test";

import { appendFileAttachmentPrompt } from "./fileAttachmentPrompt.ts";

describe("appendFileAttachmentPrompt", () => {
  it("appends resolvable file paths without reading their contents", () => {
    const prompt = appendFileAttachmentPrompt({
      prompt: "Compare these files.",
      attachments: [
        {
          type: "file",
          id: "thread-file-00000000-0000-4000-8000-000000000001",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 12,
        },
      ],
      resolvePath: () => "/tmp/attachments/notes.txt",
    });

    expect(prompt).toBe(
      "Compare these files.\n\n# Files mentioned by the user:\n## notes.txt: /tmp/attachments/notes.txt",
    );
  });

  it("leaves the prompt unchanged when no file path resolves", () => {
    expect(
      appendFileAttachmentPrompt({
        prompt: "Keep going.",
        attachments: [
          {
            type: "file",
            id: "thread-file-00000000-0000-4000-8000-000000000002",
            name: "missing.pdf",
            mimeType: "application/pdf",
            sizeBytes: 24,
          },
        ],
        resolvePath: () => null,
      }),
    ).toBe("Keep going.");
  });
});
