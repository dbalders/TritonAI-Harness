import { describe, expect, it, vi } from "vite-plus/test";

import { toOpenCodeFileParts } from "./opencodeRuntime.ts";

describe("toOpenCodeFileParts", () => {
  it("keeps generic files out of provider-native file parts", () => {
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
    ).toEqual([]);
    expect(resolveAttachmentPath).not.toHaveBeenCalled();
  });
});
