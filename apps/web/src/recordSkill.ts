import type { DesktopSkillRecordingStep } from "@t3tools/contracts";

/** Keeps a recording within a size an ordinary first message can carry. */
export const RECORD_SKILL_MAX_STEPS_CHARS = 40_000;

function formatOffset(atMs: number): string {
  const seconds = Math.floor(atMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function describeStep(step: DesktopSkillRecordingStep): string {
  const role = step.role?.replaceAll("_", " ") || "item";
  const target = step.name ? `${role} "${step.name}"` : `unnamed ${role}`;
  switch (step.kind) {
    case "app":
      return step.name ? `Switch to ${step.name}` : "Switch to another app";
    case "focus":
      return `Focus ${target}`;
    case "edit":
      return step.value === null
        ? `Enter text in ${target} (typed text not recorded)`
        : `Set ${target} to "${step.value}"`;
    case "select":
      return step.value === null ? `Select ${target}` : `Choose "${step.value}" in ${target}`;
    case "toggle":
      return `Change ${target}: ${step.value ?? "toggled"}`;
    case "window":
      return step.name ? `Window "${step.name}" appears` : "A window appears";
    case "menu":
      return step.name ? `Open menu "${step.name}"` : "Open a menu";
    case "click":
      return `${step.value ?? "Click"} ${target}`;
    case "shortcut":
      return step.value ? `Press ${step.value}` : "Press a keyboard shortcut";
  }
}

/**
 * One numbered line per recorded step. Steps past `maxChars` are left out and
 * counted, so a long recording still fits in a message.
 */
export function formatRecordedSteps(
  steps: ReadonlyArray<DesktopSkillRecordingStep>,
  maxChars = RECORD_SKILL_MAX_STEPS_CHARS,
): string {
  const lines: Array<string> = [];
  let length = 0;
  for (const [index, step] of steps.entries()) {
    const line = `${index + 1}. [${formatOffset(step.atMs)}] ${describeStep(step)}`;
    if (length + line.length + 1 > maxChars) {
      lines.push(`(${steps.length - index} more steps not included)`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

export function buildRecordSkillPrompt(input: {
  readonly durationMs: number;
  readonly limitReached: "time" | "steps" | null;
  readonly steps: string;
}): string {
  const limitNote =
    input.limitReached === "time"
      ? " It hit the time limit, so the end of the task is missing."
      : input.limitReached === "steps"
        ? " It hit the step limit, so the end of the task is missing."
        : "";
  return [
    "I just recorded myself doing a task on this computer so you can turn it into a reusable agent skill.",
    "",
    `Harness noted these steps while I worked (${formatOffset(input.durationMs)} long).${limitNote} This list is everything Harness captured; there is no screen recording or video. Treat it as a rough outline, not an exact record: some clicks, shortcuts, and anything an app does not expose can be missing, text I typed was not captured, and some steps may be detours or mistakes.`,
    "",
    "<recorded_steps>",
    input.steps.trim(),
    "</recorded_steps>",
    "",
    "Before writing anything, we'll trim and finalize the steps together:",
    "1. Start by walking me through every step as you understand it, as a short numbered list in plain language. Group steps that belong together and mark the ones that look like noise, detours, or mistakes.",
    "2. Ask which steps to drop or change, what to call the skill, what it should accomplish, and which values change from run to run (names, dates, amounts, files).",
    "3. Show me the updated steps after each change until I say they are right.",
    "Ask a few questions at a time. Do not invent steps the recording does not support; where something is unclear, ask me.",
    "",
    "Once I confirm the steps, write the skill:",
    "1. Create a folder named with a short kebab-case form of the skill name, containing a SKILL.md with YAML frontmatter (`name`, and a `description` that says when to use it) and clear instructions. If you have a skill-authoring skill such as skill-creator, use it.",
    "2. Save it in my personal Codex skills folder, `$CODEX_HOME/skills/<name>/`, and tell me the exact path.",
    "3. Turn values that change between runs into inputs the skill asks for instead of copying the ones from this recording.",
    "4. List prerequisites (the apps, sign-in, permissions) and how to check the task succeeded.",
    "5. Never include passwords, tokens, or other secrets, even if they appear above.",
    "6. Have the skill do the task with the tools you normally have, such as computer use when it is available. It must not depend on this recording.",
    "",
    "When it is written, show me the SKILL.md and suggest one safe way to test it.",
  ].join("\n");
}
