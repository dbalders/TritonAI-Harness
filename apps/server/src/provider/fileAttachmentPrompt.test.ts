import { describe, expect, it } from "vite-plus/test";

import { appendFileAttachmentPrompt } from "./fileAttachmentPrompt.ts";

describe("appendFileAttachmentPrompt", () => {
  it("appends resolvable file metadata without reading its contents", () => {
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
      [
        "Compare these files.",
        "",
        "# Files mentioned by the user:",
        "",
        "Inspect these files with format-appropriate tools. Start with bounded samples rather than printing entire files, and validate derived values before answering.",
        "",
        "## notes.txt",
        "- Path: /tmp/attachments/notes.txt",
        "- Media type: text/plain",
        "- Size: 12 bytes",
      ].join("\n"),
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
