import packageJson from "../package.json" with { type: "json" };

export const TRITONAI_CLIENT_NAME = "harness";
export const TRITONAI_CLIENT_VERSION = packageJson.version;
const TRITONAI_CLIENT_HEADER = "X-TritonAI-Client";
const TRITONAI_CLIENT_VERSION_HEADER = "X-TritonAI-Client-Version";

export function makeTritonAiClientHeaders(): Record<string, string> {
  return {
    [TRITONAI_CLIENT_HEADER]: TRITONAI_CLIENT_NAME,
    [TRITONAI_CLIENT_VERSION_HEADER]: TRITONAI_CLIENT_VERSION,
  };
}
