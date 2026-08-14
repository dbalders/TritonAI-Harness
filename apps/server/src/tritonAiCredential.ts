import {
  TRITONAI_API_KEY_ENV,
  TRITONAI_FRONTIER_API_KEY_ENV,
  TRITONAI_ONPREM_API_KEY_ENV,
} from "@t3tools/contracts";

export type TritonAiCredentialEnvironment =
  | {
      readonly TRITONAI_API_KEY?: string | undefined;
      readonly TRITONAI_ONPREM_API_KEY?: string | undefined;
      readonly TRITONAI_FRONTIER_API_KEY?: string | undefined;
    }
  | NodeJS.ProcessEnv;

/**
 * Resolve a credential for TritonAI services that are not tied to a model
 * route. A combined key stays authoritative; split installs prefer the
 * on-prem key and fall back to the frontier key for frontier-only users.
 */
export function resolveTritonAiServiceApiKey(
  environment: TritonAiCredentialEnvironment,
): string | undefined {
  for (const value of [
    environment[TRITONAI_API_KEY_ENV]?.trim(),
    environment[TRITONAI_ONPREM_API_KEY_ENV]?.trim(),
    environment[TRITONAI_FRONTIER_API_KEY_ENV]?.trim(),
  ]) {
    if (value) return value;
  }
  return undefined;
}
