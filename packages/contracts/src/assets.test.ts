import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AssetResource } from "./assets.ts";

const decodeAssetResource = Schema.decodeUnknownSync(AssetResource);

describe("AssetResource", () => {
  // regression: #433 fix(files): offer open and download actions for unsupported files
  it("preserves explicit download requests for host and workspace files", () => {
    for (const resource of [
      { _tag: "workspace-file", threadId: "thread-1", path: "deck.pptx" },
      { _tag: "media-file", threadId: "thread-1", path: "/tmp/archive.zip" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "workbook.xlsx" },
    ]) {
      const download = { ...resource, disposition: "attachment" };
      expect(decodeAssetResource(download)).toEqual(download);
    }
  });

  it("accepts legacy attachment URL requests without a thread id", () => {
    expect(
      decodeAssetResource({
        _tag: "attachment",
        attachmentId: "thread-1-00000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      _tag: "attachment",
      attachmentId: "thread-1-00000000-0000-4000-8000-000000000001",
    });
  });
});
