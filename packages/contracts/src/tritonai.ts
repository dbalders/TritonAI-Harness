export const TRITONAI_APP_BASE_NAME = "TritonAI Harness";
export const TRITONAI_APP_ID_BASE = "edu.ucsd.tritonai.harness";
export const TRITONAI_CONNECT_NAME = "TritonAI Connect";

export const TRITONAI_HOME_ENV = "TRITONAI_HOME";
export const LEGACY_T3CODE_HOME_ENV = "T3CODE_HOME";
export const DEFAULT_TRITONAI_HOME_DIRNAME = ".tritonai-harness";
// Stable keeps its historical identity; Nightly owns a separate install and profile.
export function isTritonAiNightlyVersion(version: string): boolean {
  return /-nightly\.\d{8}\.\d+$/.test(version);
}

export function resolveTritonAiDesktopIdentity(version: string) {
  const nightly = isTritonAiNightlyVersion(version);
  return {
    appId: nightly ? `${TRITONAI_APP_ID_BASE}.nightly` : TRITONAI_APP_ID_BASE,
    packageName: nightly ? "tritonai-harness-nightly" : "tritonai-harness",
    homeDirName: nightly
      ? `${DEFAULT_TRITONAI_HOME_DIRNAME}-nightly`
      : DEFAULT_TRITONAI_HOME_DIRNAME,
  };
}

export const DEFAULT_TRITONAI_HOME_PATH = `~/${DEFAULT_TRITONAI_HOME_DIRNAME}`;
export const DEFAULT_TRITONAI_CODEX_HOME_PATH = `${DEFAULT_TRITONAI_HOME_PATH}/codex`;

export const TRITONAI_API_KEY_ENV = "TRITONAI_API_KEY";
export const TRITONAI_ONPREM_API_KEY_ENV = "TRITONAI_ONPREM_API_KEY";
export const TRITONAI_FRONTIER_API_KEY_ENV = "TRITONAI_FRONTIER_API_KEY";
export const TRITONAI_API_KEY_SOURCE_ENV = "TRITONAI_API_KEY_SOURCE";
export const TRITONAI_ONPREM_PROVIDER_INSTANCE_ID = "codex";
export const TRITONAI_FRONTIER_PROVIDER_INSTANCE_ID = "codex_frontier";
export const UCSD_AI_BASE_URL_ENV = "UCSD_AI_BASE_URL";
export const DEFAULT_TRITONAI_AI_BASE_URL = "https://tritonai-api.ucsd.edu/v1";

export const TRITONAI_CODEX_MODEL_PROVIDER_ID = "ucsd";
export const TRITONAI_CODEX_MODEL_PROVIDER_NAME = "UCSD TritonAI";
export const DEFAULT_TRITONAI_CODEX_MODEL = "api-deepseek-v4-flash";
export const DEFAULT_TRITONAI_CODEX_MODEL_DISPLAY_NAME = "DeepSeek v4 Flash";
export const TRITONAI_IMAGE_CONTEXT_MODEL = "api-muse-glimmer-30b";
