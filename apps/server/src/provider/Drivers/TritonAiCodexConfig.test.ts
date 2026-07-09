import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  DEFAULT_TRITONAI_AI_BASE_URL,
  DEFAULT_TRITONAI_CODEX_MODEL,
  TRITONAI_API_KEY_ENV,
} from "@t3tools/contracts";
import { makeTritonAiCodexConfigArgs, resolveTritonAiCodexBaseUrl } from "./TritonAiCodexConfig.ts";

function configValues(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--config") {
      values.push(args[index + 1] ?? "");
      index += 1;
    }
  }
  return values;
}

describe("TritonAiCodexConfig", () => {
  it("builds Codex config overrides for the UCSD provider", () => {
    const values = configValues(
      makeTritonAiCodexConfigArgs({
        UCSD_AI_BASE_URL: "https://tritonai.example.test/v1/",
      }),
    );

    NodeAssert.deepStrictEqual(values, [
      'model_provider="ucsd"',
      `model="${DEFAULT_TRITONAI_CODEX_MODEL}"`,
      'model_providers.ucsd.name="UCSD TritonAI"',
      'model_providers.ucsd.base_url="https://tritonai.example.test/v1"',
      `model_providers.ucsd.env_key="${TRITONAI_API_KEY_ENV}"`,
      'model_providers.ucsd.wire_api="responses"',
      "model_providers.ucsd.requires_openai_auth=false",
      "model_providers.ucsd.stream_idle_timeout_ms=300000",
      "features.multi_agent=false",
    ]);
  });

  it("falls back to the default TritonAI base URL", () => {
    NodeAssert.equal(resolveTritonAiCodexBaseUrl({}), DEFAULT_TRITONAI_AI_BASE_URL);
  });
});
