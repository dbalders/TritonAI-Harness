import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

import { TRITONAI_FIRST_RUN_PROMPT } from "../tritonAiWorkspace";

/**
 * The getting started guide: a short set of quests that teach someone who has
 * never used an AI tool how to work in Harness by doing real, small tasks in
 * the composer. Each step finishes itself when the person does the thing it
 * teaches, so the guide never asks them to confirm what they just did.
 */

export type GettingStartedChapterId = "first-conversation" | "connect" | "make-it-yours";

export interface GettingStartedChapter {
  readonly id: GettingStartedChapterId;
  readonly title: string;
}

export const GETTING_STARTED_CHAPTERS: ReadonlyArray<GettingStartedChapter> = [
  { id: "first-conversation", title: "Your first conversation" },
  { id: "connect", title: "Connect your work" },
  { id: "make-it-yours", title: "Make it yours" },
];

/** What the step's main button does. */
export type GettingStartedAction =
  /** Fills the composer with an example the person can edit before sending. */
  | { readonly kind: "prompt"; readonly label: string; readonly prompt: string }
  /** Opens the most recent conversation so the person can reply in it. */
  | { readonly kind: "open-latest-thread"; readonly label: string }
  | { readonly kind: "open-plugins"; readonly label: string }
  /** Nothing to do but read; the button completes the step. */
  | { readonly kind: "acknowledge"; readonly label: string };

/** The evidence that finishes a step. */
export type GettingStartedCompletion =
  /** Any message sent successfully. */
  | "any-send"
  /** A reply in a conversation that already has messages. */
  | "follow-up"
  /** A message sent with at least one file or image. */
  | "attachment"
  /** A message that uses a $skill. */
  | "skill"
  /** A message sent from the draft this step filled in. */
  | "quest-send"
  /** A plugin that needs a sign-in is connected. */
  | "connected"
  | "acknowledge";

export interface GettingStartedStep {
  readonly id: string;
  readonly chapter: GettingStartedChapterId;
  readonly title: string;
  readonly body: string;
  readonly tip: string | null;
  readonly action: GettingStartedAction;
  readonly completion: GettingStartedCompletion;
  /** Steps that must be finished first. */
  readonly requires?: ReadonlyArray<string>;
  /** Only available from the day after the guide was started. */
  readonly unlocksNextDay?: boolean;
}

export const GETTING_STARTED_STEPS: ReadonlyArray<GettingStartedStep> = [
  {
    id: "say-hello",
    chapter: "first-conversation",
    title: "Say hello",
    body: "Type in the box the way you'd message a helpful coworker. There's no special wording to learn.",
    tip: "Replace [your role] with what you do, then press Enter to send.",
    action: { kind: "prompt", label: "Fill in the box for me", prompt: TRITONAI_FIRST_RUN_PROMPT },
    completion: "any-send",
  },
  {
    id: "follow-up",
    chapter: "first-conversation",
    title: "Keep the conversation going",
    body: "The assistant remembers everything said in a conversation, so you can just reply. Ask it to go deeper, make something shorter, or try again.",
    tip: "Try: “Walk me through the first idea, one step at a time.”",
    action: { kind: "open-latest-thread", label: "Go to my conversation" },
    completion: "follow-up",
  },
  {
    id: "share-file",
    chapter: "first-conversation",
    title: "Hand it a file",
    body: "Drag a document, spreadsheet, or image onto the box, or click the paperclip. The assistant reads it and works on it with you.",
    tip: "Attach the file before you send. Any work file you're comfortable sharing is fine.",
    action: {
      kind: "prompt",
      label: "Fill in the box for me",
      prompt:
        "I've attached a file. Summarize it in five bullet points, then list any deadlines or action items for me.",
    },
    completion: "attachment",
  },
  {
    id: "connect-tools",
    chapter: "connect",
    title: "Connect your email and calendar",
    body: "Sign in to Microsoft 365 or Google Workspace so the assistant can look at your calendar, email, and files when you ask. You choose what it can see and change.",
    tip: "Use your UC San Diego account. You can disconnect at any time.",
    action: { kind: "open-plugins", label: "Open Plugins" },
    completion: "connected",
  },
  {
    id: "morning-brief",
    chapter: "connect",
    title: "Get your first morning brief",
    body: "With your tools connected, ask for a quick rundown of your day. It takes seconds and is a good habit to start each morning with.",
    tip: "Edit the request to fit how you work before sending.",
    action: {
      kind: "prompt",
      label: "Fill in the box for me",
      prompt:
        "Give me a short morning brief: today's meetings from my calendar, emails from the last day that need a reply from me, and anything I can safely ignore.",
    },
    completion: "quest-send",
    requires: ["connect-tools"],
  },
  {
    id: "use-skill",
    chapter: "make-it-yours",
    title: "Use a skill",
    body: "Skills are saved instructions for work you do often, like writing in UC San Diego style or checking accessibility. Type $ in the box to browse them.",
    tip: "Pick a skill from the list, then describe your task after it.",
    action: { kind: "prompt", label: "Show me the skills", prompt: "$" },
    completion: "skill",
  },
  {
    id: "stay-in-control",
    chapter: "make-it-yours",
    title: "Decide how much it does on its own",
    body: "The assistant can create and edit files in your project folder. The mode menu under the box sets how much it does alone: Supervised asks before every change, and Auto handles routine steps but asks about risky ones. Everything it does shows up in the conversation.",
    tip: "Not sure yet? Choose Supervised for anything unfamiliar.",
    action: { kind: "acknowledge", label: "Got it" },
    completion: "acknowledge",
  },
  {
    id: "pick-up",
    chapter: "make-it-yours",
    title: "Pick up where you left off",
    body: "Memory writes a short note about each day's work, so the assistant can help you continue the next day without starting over.",
    tip: null,
    action: {
      kind: "prompt",
      label: "Fill in the box for me",
      prompt: "What did I work on yesterday, and what's still open?",
    },
    completion: "quest-send",
    unlocksNextDay: true,
  },
];

export type GettingStartedProgress = Readonly<Record<string, string>>;

export type GettingStartedStepStatus = "done" | "available" | "locked";

export interface GettingStartedStepView {
  readonly step: GettingStartedStep;
  readonly status: GettingStartedStepStatus;
  /** Why a locked step is not available yet. */
  readonly lockedReason: string | null;
}

export interface GettingStartedState {
  readonly steps: ReadonlyArray<GettingStartedStepView>;
  readonly completedCount: number;
  readonly total: number;
  /** The first step the person can do now, or null when none is available. */
  readonly nextStep: GettingStartedStepView | null;
  readonly isComplete: boolean;
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** The earliest recorded completion, which is when the guide was started. */
function resolveGuideStartedAt(progress: GettingStartedProgress): Date | null {
  let earliest: Date | null = null;
  for (const value of Object.values(progress)) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (earliest === null || date < earliest) earliest = date;
  }
  return earliest;
}

function resolveLockedReason(
  step: GettingStartedStep,
  progress: GettingStartedProgress,
  now: Date,
): string | null {
  const missing = (step.requires ?? []).find((id) => progress[id] === undefined);
  if (missing !== undefined) {
    const title = GETTING_STARTED_STEPS.find((candidate) => candidate.id === missing)?.title;
    return title ? `Finish “${title}” first.` : "Finish the earlier steps first.";
  }
  if (step.unlocksNextDay) {
    const startedAt = resolveGuideStartedAt(progress);
    if (startedAt === null || localDayKey(startedAt) === localDayKey(now)) {
      return "Available tomorrow. Come back after a day of work and try it.";
    }
  }
  return null;
}

export function resolveGettingStartedState(
  progress: GettingStartedProgress,
  now: Date,
): GettingStartedState {
  const steps = GETTING_STARTED_STEPS.map((step): GettingStartedStepView => {
    if (progress[step.id] !== undefined) {
      return { step, status: "done", lockedReason: null };
    }
    const lockedReason = resolveLockedReason(step, progress, now);
    return { step, status: lockedReason === null ? "available" : "locked", lockedReason };
  });
  const completedCount = steps.filter((view) => view.status === "done").length;
  return {
    steps,
    completedCount,
    total: steps.length,
    nextStep: steps.find((view) => view.status === "available") ?? null,
    isComplete: completedCount === steps.length,
  };
}

export interface GettingStartedSendEvent {
  /** False for the first message of a conversation. */
  readonly isFollowUp: boolean;
  readonly attachmentCount: number;
  readonly text: string;
  /** The step whose example filled the draft this message came from. */
  readonly questStepId: string | null;
}

function sendCompletes(step: GettingStartedStep, event: GettingStartedSendEvent): boolean {
  switch (step.completion) {
    case "any-send":
      return true;
    case "follow-up":
      return event.isFollowUp;
    case "attachment":
      return event.attachmentCount > 0;
    case "skill":
      return collectComposerInlineTokens(event.text).some((token) => token.type === "skill");
    case "quest-send":
      return event.questStepId === step.id;
    case "connected":
    case "acknowledge":
      return false;
  }
}

/** The available steps a successfully sent message finishes. */
export function resolveStepsCompletedBySend(
  state: GettingStartedState,
  event: GettingStartedSendEvent,
): ReadonlyArray<string> {
  return state.steps
    .filter((view) => view.status === "available" && sendCompletes(view.step, event))
    .map((view) => view.step.id);
}

/** Adds completions without moving the time of a step that is already done. */
export function mergeGettingStartedProgress(
  progress: GettingStartedProgress,
  stepIds: ReadonlyArray<string>,
  completedAt: string,
): GettingStartedProgress {
  const added = stepIds.filter((id) => progress[id] === undefined);
  if (added.length === 0) return progress;
  return { ...progress, ...Object.fromEntries(added.map((id) => [id, completedAt])) };
}
