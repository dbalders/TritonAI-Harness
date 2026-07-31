export const TRITONAI_FIRST_RUN_PROMPT = "How does TritonAI Harness work, and how can it help me?";
export const TRITONAI_FIRST_RUN_WORKSPACE = "~/TritonAI";

const TRITONAI_APP_BASE_NAME = "TritonAI Harness";

function normalizeWorkspacePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/g, "").toLowerCase();
}

function isHomeRelativePath(normalizedPath: string, suffix: string): boolean {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    normalizedPath === `~/${suffix}` ||
    new RegExp(`^/(users|home)/[^/]+/${escapedSuffix}$`, "i").test(normalizedPath) ||
    new RegExp(`^[a-z]:/users/[^/]+/${escapedSuffix}$`, "i").test(normalizedPath)
  );
}

export function isTritonAiCodeBrand(appBaseName: string): boolean {
  return appBaseName.trim() === TRITONAI_APP_BASE_NAME;
}

export function isTritonAiWorkspacePath(path: string): boolean {
  return isHomeRelativePath(normalizeWorkspacePath(path), "tritonai");
}

export function resolveTritonAiFirstRunWorkspacePath(): string {
  return TRITONAI_FIRST_RUN_WORKSPACE;
}
