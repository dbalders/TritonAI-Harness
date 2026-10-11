/**
 * `/feedback` belongs to TritonAI: it runs the `tritonai-feedback` skill
 * maintained in UCSD-Skills-Library. Codex's native upload to OpenAI moves to
 * `/openai-feedback`.
 *
 * @module tritonAiFeedback
 */

export const TRITONAI_FEEDBACK_COMMAND_NAME = "feedback";
export const TRITONAI_FEEDBACK_SKILL_NAME = "tritonai-feedback";
export const OPENAI_FEEDBACK_COMMAND_NAME = "openai-feedback";

const FEEDBACK_COMMAND_PATTERN = /^(\s*)\/feedback(?=\s|$)/iu;

/** Rewrites a leading `/feedback` into an explicit mention of the feedback skill. */
export function rewriteTritonAiFeedbackCommand(prompt: string): string {
  return prompt.replace(FEEDBACK_COMMAND_PATTERN, `$1$${TRITONAI_FEEDBACK_SKILL_NAME}`);
}
