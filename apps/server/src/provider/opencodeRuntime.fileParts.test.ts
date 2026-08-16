import { describe, expect, it, vi } from "vite-plus/test";

import { toOpenCodeFileParts } from "./opencodeRuntime.ts";

describe("toOpenCodeFileParts", () => {
  it("uses an original local path without invoking stored-attachment resolution", () => {
    const resolveAttachmentPath = vi.fn(() => null);

    expect(
      toOpenCodeFileParts({
        attachments: [
          {
            type: "file",
            id: "local-file-1",
            name: "large.csv",
            mimeType: "text/csv",
            sizeBytes: 100 * 1024 * 1024,
            path: "/Users/david/Downloads/large.csv",
          },
        ],
        resolveAttachmentPath,
      }),
    ).toEqual([
      {
        type: "file",
        mime: "text/csv",
        filename: "large.csv",
        url: "file:///Users/david/Downloads/large.csv",
      },
    ]);
    expect(resolveAttachmentPath).not.toHaveBeenCalled();
  });
});
