import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { ServerTritonAiCommonsError } from "@t3tools/contracts";

export function tritonAiCommonsPublicShareConfirmation(input: {
  readonly displayName: string;
  readonly skillPath: string;
}): string {
  return [
    `Share ${input.displayName} publicly with UCSD through TritonAI Commons?`,
    "",
    `Every supported, non-hidden text file in this local skill folder will be copied to the public dbalders/UCSD-Skills-Library repository under community/:\n${input.skillPath}`,
    "",
    "If the folder has no LICENSE, Harness will add the current TritonAI Commons MIT license to the public copy. A conflicting local license stops the submission.",
    "",
    "Harness will use your connected GitHub identity. It may create a personal fork, branch, commits, and a ready-for-review pull request. Maintainers decide whether to accept it; Harness will never merge it or change your local files.",
    "",
    "Review the folder for private, regulated, or sensitive information before continuing.",
  ].join("\n");
}

export function findTritonAiCommonsFailure(
  result: AtomCommandResult<unknown, unknown>,
): ServerTritonAiCommonsError | null {
  if (result._tag !== "Failure") return null;
  for (const reason of result.cause.reasons) {
    if (
      reason._tag === "Fail" &&
      typeof reason.error === "object" &&
      reason.error !== null &&
      "_tag" in reason.error &&
      reason.error._tag === "ServerTritonAiCommonsError" &&
      "code" in reason.error &&
      "message" in reason.error
    ) {
      return reason.error as ServerTritonAiCommonsError;
    }
  }
  return null;
}

export const GITHUB_COMMONS_SETUP_CONTINUATION =
  "GitHub setup is required before this public share can continue. Open Settings > Plugins > GitHub, connect your contributor account, and enable Read GitHub identity, Read repositories, Contribute repository changes, and Create pull requests. Then return to Settings > Skills and press Share with UCSD again; Harness will revalidate the same local skill before writing.";
