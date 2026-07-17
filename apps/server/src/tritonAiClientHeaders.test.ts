import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  makeTritonAiClientHeaders,
  TRITONAI_CLIENT_NAME,
  TRITONAI_CLIENT_VERSION,
} from "./tritonAiClientHeaders.ts";

describe("makeTritonAiClientHeaders", () => {
  it("returns only the stable product and application version markers", () => {
    NodeAssert.deepStrictEqual(makeTritonAiClientHeaders(), {
      "X-TritonAI-Client": TRITONAI_CLIENT_NAME,
      "X-TritonAI-Client-Version": TRITONAI_CLIENT_VERSION,
    });
  });
});
