export const TRITONAI_APP_BASE_NAME = "TritonAI Harness";
export const TRITONAI_APP_ID_BASE = "edu.ucsd.tritonai.harness";

export const TRITONAI_HOME_ENV = "TRITONAI_HOME";
export const LEGACY_T3CODE_HOME_ENV = "T3CODE_HOME";
export const DEFAULT_TRITONAI_HOME_DIRNAME = ".tritonai-harness";
export const DEFAULT_TRITONAI_HOME_PATH = `~/${DEFAULT_TRITONAI_HOME_DIRNAME}`;
export const DEFAULT_TRITONAI_CODEX_HOME_PATH = `${DEFAULT_TRITONAI_HOME_PATH}/codex`;

export const TRITONAI_API_KEY_ENV = "TRITONAI_API_KEY";
export const UCSD_AI_BASE_URL_ENV = "UCSD_AI_BASE_URL";
export const DEFAULT_TRITONAI_AI_BASE_URL = "https://tritonai-api.ucsd.edu/v1";

export const TRITONAI_CODEX_MODEL_PROVIDER_ID = "ucsd";
export const TRITONAI_CODEX_MODEL_PROVIDER_NAME = "UCSD TritonAI";
export const DEFAULT_TRITONAI_CODEX_MODEL = "deepseek-v4-flash";
export const DEFAULT_TRITONAI_CODEX_MODEL_DISPLAY_NAME = "DeepSeek v4 Flash";
export const TRITONAI_VISIBLE_CODEX_MODELS = [
  DEFAULT_TRITONAI_CODEX_MODEL,
  "gpt-5.5",
  "claude-opus-4-8",
] as const;
