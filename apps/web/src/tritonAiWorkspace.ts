// The first step of the getting started guide; a fresh install opens with it in the composer.
export const TRITONAI_FIRST_RUN_PROMPT =
  "Hi! I'm new to AI tools. I work at UC San Diego as [your role]. What are three everyday tasks you could help me with? Keep it short.";
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
