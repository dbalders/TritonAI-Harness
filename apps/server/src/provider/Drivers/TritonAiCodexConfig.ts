import {
  DEFAULT_TRITONAI_AI_BASE_URL,
  DEFAULT_TRITONAI_CODEX_MODEL,
  TRITONAI_API_KEY_ENV,
  TRITONAI_CODEX_MODEL_PROVIDER_ID,
  TRITONAI_CODEX_MODEL_PROVIDER_NAME,
  UCSD_AI_BASE_URL_ENV,
} from "@t3tools/contracts";
import {
  TRITONAI_CLIENT_HEADER,
  TRITONAI_CLIENT_NAME,
  TRITONAI_CLIENT_VERSION,
  TRITONAI_CLIENT_VERSION_HEADER,
} from "../../tritonAiClientHeaders.ts";

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export const encodeCodexConfigString = (value: string): string => JSON.stringify(value);

export function resolveTritonAiCodexBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[UCSD_AI_BASE_URL_ENV]?.trim();
  return trimTrailingSlash(
    configured && configured.length > 0 ? configured : DEFAULT_TRITONAI_AI_BASE_URL,
  );
}

export function makeTritonAiCodexConfigArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const providerKey = `model_providers.${TRITONAI_CODEX_MODEL_PROVIDER_ID}`;
  const baseUrl = resolveTritonAiCodexBaseUrl(env);

  return [
    "--config",
    `model_provider=${encodeCodexConfigString(TRITONAI_CODEX_MODEL_PROVIDER_ID)}`,
    "--config",
    `model=${encodeCodexConfigString(DEFAULT_TRITONAI_CODEX_MODEL)}`,
    "--config",
    `${providerKey}.name=${encodeCodexConfigString(TRITONAI_CODEX_MODEL_PROVIDER_NAME)}`,
    "--config",
    `${providerKey}.base_url=${encodeCodexConfigString(baseUrl)}`,
    "--config",
    `${providerKey}.env_key=${encodeCodexConfigString(TRITONAI_API_KEY_ENV)}`,
    "--config",
    `${providerKey}.wire_api="responses"`,
    "--config",
    `${providerKey}.http_headers={${encodeCodexConfigString(TRITONAI_CLIENT_HEADER)}=${encodeCodexConfigString(TRITONAI_CLIENT_NAME)},${encodeCodexConfigString(TRITONAI_CLIENT_VERSION_HEADER)}=${encodeCodexConfigString(TRITONAI_CLIENT_VERSION)}}`,
    "--config",
    `${providerKey}.requires_openai_auth=false`,
    "--config",
    `${providerKey}.stream_idle_timeout_ms=300000`,
    "--config",
    'web_search="disabled"',
    "--config",
    "features.multi_agent=false",
  ];
}
