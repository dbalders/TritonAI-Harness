import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AssetResource } from "./assets.ts";

const decodeAssetResource = Schema.decodeUnknownSync(AssetResource);

describe("AssetResource", () => {
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
