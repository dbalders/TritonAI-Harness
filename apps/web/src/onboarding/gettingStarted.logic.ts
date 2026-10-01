import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";

import { isComputerUseRequest } from "../computerUse";
import { TRITONAI_FIRST_RUN_PROMPT } from "../tritonAiWorkspace";

/**
 * The getting started guide: a short set of quests that teach someone who has
 * never used an AI tool how to work in Harness by doing real, small tasks in
 * the composer. Each step finishes itself when the person does the thing it
 * teaches, so the guide never asks them to confirm what they just did.
 *
 * The main quest is what "finished" means. Side quests are optional extras
 * that stay available afterwards.
 */

export type GettingStartedChapterId =
  | "first-conversation"
  | "connect"
  | "make-it-yours"
  | "side-quests";

export interface GettingStartedChapter {
  readonly id: GettingStartedChapterId;
  readonly title: string;
  /** Optional chapters do not count toward finishing the guide. */
  readonly optional?: boolean;
}

export const GETTING_STARTED_CHAPTERS: ReadonlyArray<GettingStartedChapter> = [
  { id: "first-conversation", title: "Your first conversation" },
  { id: "connect", title: "Connect your work" },
  { id: "make-it-yours", title: "Make it yours" },
  { id: "side-quests", title: "Side quests", optional: true },
];

export interface GettingStartedIdea {
  readonly label: string;
  readonly prompt: string;
}

/** What the step's main button does. */
export type GettingStartedAction =
  /** Fills the composer with an example the person can edit before sending. */
  | { readonly kind: "prompt"; readonly label: string; readonly prompt: string }
  /** Offers several examples; picking one fills the composer. */
  | { readonly kind: "ideas"; readonly ideas: ReadonlyArray<GettingStartedIdea> }
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
  /** A message that asks for computer use. */
  | "computer-use"
  /** A message sent from the draft this step filled in. */
  | "quest-send"
  /** A plugin that needs a sign-in is connected. */
  | "connected"
  | "acknowledge";

export interface GettingStartedStep {
  readonly id: string;
  readonly chapter: GettingStartedChapterId;
  readonly title: string;
  /** One line telling the person what to do. */
  readonly summary: string;
  /** Replaces the summary once the step's example is in the composer. */
  readonly filledHint: string | null;
  /** Said once the step is done. */
  readonly doneLine: string;
  readonly action: GettingStartedAction;
  /** A second button that opens settings the step depends on. */
  readonly settingsLink?: {
    readonly label: string;
    readonly to: "/settings/general" | "/settings/plugins";
  };
  readonly completion: GettingStartedCompletion;
  /** Steps that must be finished first. */
  readonly requires?: ReadonlyArray<string>;
  /** Only available from the day after the guide was started. */
  readonly unlocksNextDay?: boolean;
  /** Only offered in the desktop app. */
  readonly desktopOnly?: boolean;
}

const FILL = "Fill in the box for me";

export const GETTING_STARTED_IDEAS: ReadonlyArray<GettingStartedIdea> = [
  {
    label: "Reply to an email",
    prompt:
      "Here's an email I need to answer:\n\n[paste the email]\n\nDraft a friendly reply that says yes, but asks to move the deadline to Friday.",
  },
  {
    label: "Summarize a meeting",
    prompt:
      "Turn these meeting notes into a short summary with decisions, action items, and who owns each one:\n\n[paste your notes]",
  },
  {
    label: "Plan my week",
    prompt:
      "Help me plan my week. Here's what's on my plate:\n\n[list your tasks and deadlines]\n\nSuggest an order, and point out anything I could delegate or drop.",
  },
  {
    label: "Make writing clearer",
    prompt:
      "Rewrite this so it's clearer and friendlier for a campus-wide audience. Keep it about the same length:\n\n[paste your text]",
  },
  {
    label: "Explain something new",
    prompt:
      "Explain [a topic or term from my work] like I'm new to it. Then ask me three quick questions to check I understood.",
  },
  {
    label: "Write a how-to",
    prompt:
      "Write step-by-step instructions for [a process in my office] that a new staff member could follow on their first day.",
  },
  {
    label: "Understand a spreadsheet",
    prompt:
      "I've attached a spreadsheet. Tell me what's in it in plain language, point out anything unusual, and suggest one chart that would help me explain it.",
  },
  {
    label: "Brainstorm ideas",
    prompt:
      "Give me 10 ideas for [an event, project, or problem]. Then help me pick the best three and explain why.",
  },
];

export const GETTING_STARTED_STEPS: ReadonlyArray<GettingStartedStep> = [
  {
    id: "say-hello",
    chapter: "first-conversation",
    title: "Say hello",
    summary: "Send your first message. We'll write it, you just fill in your role.",
    filledHint: "Replace [your role] with what you do, then press Enter.",
    doneLine: "Nice, you sent your first message.",
    action: { kind: "prompt", label: FILL, prompt: TRITONAI_FIRST_RUN_PROMPT },
    completion: "any-send",
  },
  {
    id: "follow-up",
    chapter: "first-conversation",
    title: "Keep the conversation going",
    summary: "Reply in the same conversation. It remembers what was said.",
    filledHint: "Try: “Walk me through the first idea, one step at a time.”",
    doneLine: "Nice, that was your first back-and-forth.",
    action: { kind: "open-latest-thread", label: "Go to my conversation" },
    completion: "follow-up",
  },
  {
    id: "full-picture",
    chapter: "first-conversation",
    title: "Give it the full picture",
    summary: "Get better answers by letting it ask you a few questions first.",
    filledHint: "Fill in the brackets and send. Then answer its questions.",
    doneLine: "Good. Answering its questions is the fastest way to a great result.",
    action: {
      kind: "prompt",
      label: FILL,
      prompt:
        "I need to write [what you're writing, like an announcement for my team]. Before you write anything, ask me up to five questions so you get it right.",
    },
    completion: "quest-send",
  },
  {
    id: "share-file",
    chapter: "first-conversation",
    title: "Hand it a file",
    summary: "Attach a file with the paperclip and ask about it.",
    filledHint: "Attach a file with the paperclip, then press Enter.",
    doneLine: "Nice, it read your file.",
    action: {
      kind: "prompt",
      label: FILL,
      prompt:
        "I've attached a file. Summarize it in five bullet points, then list any deadlines or action items for me.",
    },
    completion: "attachment",
  },
  {
    id: "connect-tools",
    chapter: "connect",
    title: "Connect your email and calendar",
    summary: "Connect your email and calendar so it can help with your day.",
    filledHint: null,
    doneLine: "Your tools are connected.",
    action: { kind: "open-plugins", label: "Open Plugins" },
    completion: "connected",
  },
  {
    id: "morning-brief",
    chapter: "connect",
    title: "Get your first morning brief",
    summary: "Ask for a quick rundown of your day.",
    filledHint: "Press Enter to send.",
    doneLine: "That's your first morning brief.",
    action: {
      kind: "prompt",
      label: FILL,
      prompt:
        "Give me a short morning brief: today's meetings from my calendar, emails from the last day that need a reply from me, and anything I can safely ignore.",
    },
    completion: "quest-send",
    requires: ["connect-tools"],
  },
  {
    id: "brief-to-inbox",
    chapter: "connect",
    title: "Put your brief in your inbox",
    summary: "Have it put your brief in your email drafts. It never sends.",
    filledHint: "Press Enter. It asks before it writes the draft.",
    doneLine: "Check your Drafts folder: it's waiting for you there.",
    action: {
      kind: "prompt",
      label: FILL,
      prompt:
        "Write today's morning brief as an email draft addressed to me, with the subject “Morning brief”. Don't send it.",
    },
    completion: "quest-send",
    requires: ["connect-tools"],
  },
  {
    id: "use-skill",
    chapter: "make-it-yours",
    title: "Use a skill",
    summary: "Skills are saved recipes for common work. Type $ to see them.",
    filledHint: "Pick a skill from the list, then say what you need.",
    doneLine: "Nice, you used your first skill.",
    action: { kind: "prompt", label: "Show me the skills", prompt: "$" },
    completion: "skill",
  },
  {
    id: "stay-in-control",
    chapter: "make-it-yours",
    title: "Decide how much it does on its own",
    summary: "The mode menu under the box sets how much it does alone. Supervised asks first.",
    filledHint: null,
    doneLine: "Got it. You can change the mode any time.",
    action: { kind: "acknowledge", label: "Got it" },
    completion: "acknowledge",
  },
  {
    id: "pick-up",
    chapter: "make-it-yours",
    title: "Pick up where you left off",
    summary: "Ask what you worked on yesterday.",
    filledHint: "Press Enter to send.",
    doneLine: "That's Memory at work.",
    action: {
      kind: "prompt",
      label: FILL,
      prompt: "What did I work on yesterday, and what's still open?",
    },
    completion: "quest-send",
    unlocksNextDay: true,
  },
  {
    id: "try-ideas",
    chapter: "side-quests",
    title: "Try an idea for your job",
    summary: "Not sure what to ask? Pick an everyday task.",
    filledHint: "Fill in the brackets, then press Enter.",
    doneLine: "Nice. Come back to these ideas any time.",
    action: { kind: "ideas", ideas: GETTING_STARTED_IDEAS },
    completion: "quest-send",
  },
  {
    id: "computer-use",
    chapter: "side-quests",
    title: "Let it use your apps",
    summary: "Let it click and type in your apps while you watch. Turn it on in Settings first.",
    filledHint: "Press Enter to send.",
    doneLine: "That's computer use.",
    action: {
      kind: "prompt",
      label: FILL,
      prompt: "Use computer use to open Calculator and work out 18% of 245.",
    },
    settingsLink: { label: "Turn on computer use", to: "/settings/general" },
    completion: "computer-use",
    desktopOnly: true,
  },
  {
    id: "daily-brief",
    chapter: "side-quests",
    title: "Get your brief every morning",
    summary: "Get your brief emailed every weekday morning with n8n.",
    filledHint: "Press Enter. It asks before turning anything on.",
    doneLine: "Your morning brief is on its way.",
    action: {
      kind: "prompt",
      label: FILL,
      prompt:
        "Using n8n, set up a workflow that runs every weekday at 8:00 am and emails me a morning brief with today's meetings and the emails that need a reply. Show me the plan and ask me before you publish it.",
    },
    settingsLink: { label: "Open Plugins", to: "/settings/plugins" },
    completion: "quest-send",
    requires: ["morning-brief"],
  },
];

export type GettingStartedProgress = Readonly<Record<string, string>>;

export type GettingStartedStepStatus = "done" | "available" | "locked";

export interface GettingStartedStepView {
  readonly step: GettingStartedStep;
  readonly optional: boolean;
  readonly status: GettingStartedStepStatus;
  /** Why a locked step is not available yet. */
  readonly lockedReason: string | null;
}

export interface GettingStartedState {
  /** The steps offered here, main quest first. */
  readonly steps: ReadonlyArray<GettingStartedStepView>;
  /** Main quest progress; side quests do not count. */
  readonly completedCount: number;
  readonly total: number;
  readonly sideQuestsCompleted: number;
  readonly sideQuestsTotal: number;
  /** The first main-quest step the person can do now, or null. */
  readonly nextStep: GettingStartedStepView | null;
  /** The whole main quest is done. */
  readonly isComplete: boolean;
}

export interface GettingStartedPlatform {
  readonly desktop: boolean;
}

const OPTIONAL_CHAPTERS = new Set(
  GETTING_STARTED_CHAPTERS.filter((chapter) => chapter.optional).map((chapter) => chapter.id),
);

export function isGettingStartedStepOptional(step: GettingStartedStep): boolean {
  return OPTIONAL_CHAPTERS.has(step.chapter);
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
  platform: GettingStartedPlatform,
): GettingStartedState {
  const steps = GETTING_STARTED_STEPS.filter((step) => platform.desktop || !step.desktopOnly).map(
    (step): GettingStartedStepView => {
      const optional = isGettingStartedStepOptional(step);
      if (progress[step.id] !== undefined) {
        return { step, optional, status: "done", lockedReason: null };
      }
      const lockedReason = resolveLockedReason(step, progress, now);
      return {
        step,
        optional,
        status: lockedReason === null ? "available" : "locked",
        lockedReason,
      };
    },
  );
  const main = steps.filter((view) => !view.optional);
  const side = steps.filter((view) => view.optional);
  const completedCount = main.filter((view) => view.status === "done").length;
  return {
    steps,
    completedCount,
    total: main.length,
    sideQuestsCompleted: side.filter((view) => view.status === "done").length,
    sideQuestsTotal: side.length,
    nextStep: main.find((view) => view.status === "available") ?? null,
    isComplete: completedCount === main.length,
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
    case "computer-use":
      return isComputerUseRequest(event.text);
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

/**
 * What the guide shows inside a conversation: a celebration right after a
 * message there finished steps, otherwise a one-line "Next up".
 */
export function resolveGettingStartedThreadNudge(
  state: GettingStartedState,
  justCompletedStepIds: ReadonlyArray<string>,
): "celebrate" | "next-up" | "none" {
  if (justCompletedStepIds.length > 0) return "celebrate";
  if (state.isComplete || state.nextStep === null) return "none";
  return "next-up";
}
