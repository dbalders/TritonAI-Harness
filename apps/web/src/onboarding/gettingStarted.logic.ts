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
  readonly body: string;
  readonly tip: string | null;
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
    body: "Type in the box the way you'd message a helpful coworker. There's no special wording to learn.",
    tip: "Replace [your role] with what you do, then press Enter to send.",
    action: { kind: "prompt", label: FILL, prompt: TRITONAI_FIRST_RUN_PROMPT },
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
    id: "full-picture",
    chapter: "first-conversation",
    title: "Give it the full picture",
    body: "The more it knows, the better it does. A good request says what you want, who it's for, and what a great result looks like. When you're not sure what to say, ask it to interview you first.",
    tip: "Answer its questions in your next message. That's the fastest way to a great result.",
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
    body: "Drag a document, spreadsheet, or image onto the box, or click the paperclip. The assistant reads it and works on it with you.",
    tip: "Attach the file before you send. Any work file you're comfortable sharing is fine.",
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
    body: "Sign in to Microsoft 365 or Google Workspace so the assistant can look at your calendar, email, and files when you ask. You choose what it can see and change.",
    tip: "Use your UC San Diego account. You can disconnect at any time.",
    action: { kind: "open-plugins", label: "Open Plugins" },
    completion: "connected",
  },
  {
    id: "morning-brief",
    chapter: "connect",
    title: "Get your first morning brief",
    body: "With your tools connected, ask for a quick rundown of your day. It takes seconds, and it's a good way to start each morning.",
    tip: "Edit the request to fit how you work before sending.",
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
    body: "The assistant can write email drafts in Outlook or Gmail. It never sends email for you: the draft waits in your Drafts folder until you review it and press Send yourself.",
    tip: "Open your Drafts folder afterwards to see what it wrote.",
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
    body: "Not sure what to use it for? Pick an everyday task below. Each one fills in the box with a request you can adjust before sending.",
    tip: "Replace anything in [brackets] with your own details.",
    action: { kind: "ideas", ideas: GETTING_STARTED_IDEAS },
    completion: "quest-send",
  },
  {
    id: "computer-use",
    chapter: "side-quests",
    title: "Let it use your apps",
    body: "With computer use turned on, the assistant can open apps on this computer, click, and type for you, and you can watch everything it does. Turn it on under Settings > General first.",
    tip: "Start your request with “Use computer use to…”. Stop it at any time from the conversation.",
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
    body: "UC San Diego's n8n automation service can run a task on a schedule. Ask the assistant to build a workflow that sends you a morning brief every weekday. It shows you the plan and asks before turning anything on.",
    tip: "Needs the n8n plugin connected under Settings > Plugins.",
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
