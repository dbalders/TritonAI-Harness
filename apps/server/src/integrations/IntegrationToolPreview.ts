import { reviewIntegrationInput, snapshotIntegrationInput } from "./IntegrationWriteApproval.ts";

/** Show the complete JSON; an agent-authored summary cannot hide the effective operation. */
export function describeToolCallForApproval(toolName: string, args: unknown): string {
  return args === undefined
    ? toolName
    : `${toolName}\n${reviewIntegrationInput(snapshotIntegrationInput(args).value)}`;
}
