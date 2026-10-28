import {
  DEFAULT_GETTING_STARTED_PROGRESS,
  type EnvironmentId,
  type GettingStartedAnalyticsInput,
  type GettingStartedChapterId,
  type GettingStartedProgress,
  type ThreadId,
} from "@t3tools/contracts";

export const GETTING_STARTED_CHAPTERS = [
  { id: "welcome", title: "Meet your assistant", description: "See what it can help you do." },
  { id: "conversation", title: "Talk to AI", description: "Ask, follow up, and check an answer." },
  {
    id: "approvals",
    title: "Stay in control",
    description: "Approve or decline what it wants to do.",
  },
  {
    id: "connect",
    title: "Connect your work",
    description: "Connect Outlook or Gmail on your terms.",
  },
  { id: "connected-work", title: "Try connected work", description: "Put your connection to use." },
  { id: "files", title: "Use files & projects", description: "Give it material to work with." },
  { id: "skills", title: "Use a skill", description: "Try a saved recipe for common work." },
  { id: "ideas", title: "Explore Ideas", description: "Find a useful request ready to review." },
  {
    id: "computer-use",
    title: "Explore computer use",
    description: "Choose how it can work with desktop apps.",
  },
  {
    id: "ready",
    title: "Make it your own",
    description: "Keep working and return whenever you need.",
  },
] as const satisfies ReadonlyArray<{
  id: GettingStartedChapterId;
  title: string;
  description: string;
}>;

export const GETTING_STARTED_SAMPLE = `Turn these meeting notes into a to-do list with an owner and a deadline for each item. Mark missing details as "Not specified". Answer here in chat; don't save or change any files.

Practice notes (fictional):
- Kim will compare room options.
- Dev will prepare the laptops by Friday.
- Jordan will check the travel budget.`;

/** Practice chapters that finish from a prepared conversation's observed run. */
const TASK_CHAPTERS: ReadonlySet<GettingStartedChapterId> = new Set([
  "conversation",
  "approvals",
  "connected-work",
  "files",
  "skills",
  "ideas",
]);

export const GETTING_STARTED_APPROVAL_PRACTICE = `Turn these practice meeting notes into a to-do list with an owner and a deadline for each item, and save it as a file named practice-to-do.md in this folder. Mark missing details as "Not specified". If I decline the save, don't try again; show me the list here instead.

Practice notes (fictional):
- Kim will compare room options.
- Dev will prepare the laptops by Friday.
- Jordan will check the travel budget.`;

export const GETTING_STARTED_SAMPLE_EMAILS = `These are practice emails, not real ones. Find the messages that ask me a question. List who sent each one and what they need from me. Answer here in chat; don't draft, save, or send anything.

Practice emails (fictional):
1. From Priya Shah, "Room for Thursday": Can you confirm whether we still need the large conference room on Thursday afternoon?
2. From the Campus Newsletter, "This week at UC San Diego": Five events happening on campus this week.
3. From Marco Diaz, "Budget numbers": Could you send me the final travel budget by Wednesday so I can submit it?
4. From IT Service Desk, "Ticket closed": Your request for a new monitor has been completed.`;

export interface GettingStartedSkillRecipe {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Ready-to-review request, starting with the `$skill` names it uses. */
  readonly prompt: string;
}

/**
 * Everyday starter recipes, best first. Each one lists the skill sets that can
 * run it; plugin skills only appear once their account is connected, so the
 * list follows what the person has set up. `skill-creator` ships with Codex,
 * so there is always at least one card.
 */
const STARTER_SKILL_RECIPES: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly skillSets: ReadonlyArray<ReadonlyArray<string>>;
  readonly request: string;
}> = [
  {
    id: "morning-brief",
    title: "Morning brief",
    description: "Today's meetings and the emails waiting on you.",
    skillSets: [
      ["outlook-calendar", "outlook-mail"],
      ["google-calendar", "gmail"],
    ],
    request:
      "Give me a short morning brief: today's meetings with their times, then up to five emails from the last day that need my reply. Only read; don't draft, change, move, or send anything.",
  },
  {
    id: "recent-files",
    title: "Find a recent file",
    description: "See what you've been working on lately.",
    skillSets: [["onedrive-files"], ["google-drive"]],
    request:
      "List the five files I changed most recently, with one line on what each seems to be. Only read; don't change anything.",
  },
  {
    id: "campus-answer",
    title: "Look up a campus answer",
    description: "Find official UC San Diego guidance, with links.",
    skillSets: [["ucsd-campus-search"]],
    request:
      "Find the official UC San Diego guidance on getting a campus parking permit and summarize it in three short bullets, with links to the original pages.",
  },
  {
    id: "jira-plate",
    title: "What's on my plate in Jira",
    description: "Your open issues, newest first.",
    skillSets: [["ucsd-jira"]],
    request:
      "List my open Jira issues, newest first, with each one's status. Only read; don't change anything.",
  },
  {
    id: "make-a-skill",
    title: "Make your own skill",
    description: "Turn work you repeat into a saved recipe.",
    skillSets: [["skill-creator"]],
    request:
      "Help me plan a skill for a task I repeat every week. Ask me what the task is first, and don't create any files yet.",
  },
];

/** Up to three starter recipes the person can run with the skills they have now. */
export function gettingStartedSkillRecipes(
  available: ReadonlySet<string>,
): ReadonlyArray<GettingStartedSkillRecipe> {
  return STARTER_SKILL_RECIPES.flatMap(({ skillSets, request, ...recipe }) => {
    const skills = skillSets.find((set) => set.every((name) => available.has(name)));
    return skills
      ? [{ ...recipe, prompt: `${skills.map((name) => `$${name}`).join(" ")} ${request}` }]
      : [];
  }).slice(0, 3);
}

export type GettingStartedEvent = (
  | { type: "start"; environmentId: EnvironmentId; at: string }
  | { type: "select"; chapter: GettingStartedChapterId }
  | { type: "close" | "pause" | "restart" }
  | { type: "next" | "later" }
  | {
      type: "acknowledge";
      chapter: "welcome" | "computer-use" | "ready";
      continue?: "next" | "pause";
    }
  | { type: "connection-ready"; environmentId: EnvironmentId }
  | { type: "submitted"; environmentId: EnvironmentId; threadId: ThreadId; messageId: string }
  | {
      type: "track";
      chapter: GettingStartedChapterId;
      environmentId: EnvironmentId;
      threadId: ThreadId;
      at: string;
      toolNames?: ReadonlyArray<string>;
    }
  | { type: "checked-source"; environmentId: EnvironmentId; threadId: ThreadId }
  | {
      type: "run";
      environmentId: EnvironmentId;
      threadId: ThreadId;
      runId: string;
      startedAt: string;
      succeeded: boolean;
      hasAnswer: boolean;
      userMessageId?: string;
      connectedToolSucceeded: boolean;
      usedFile: boolean;
      answeredApproval: boolean;
      usedSkill: boolean;
    }
) & { readonly generation?: number; readonly fromChapter?: GettingStartedChapterId };

function complete(
  state: GettingStartedProgress,
  chapter: GettingStartedChapterId,
): GettingStartedProgress {
  if (state.completed.includes(chapter)) return state;
  return {
    ...state,
    completed: [...state.completed, chapter],
    deferred: state.deferred.filter((item) => item !== chapter),
  };
}

function nextChapter(state: GettingStartedProgress): GettingStartedChapterId {
  const index = GETTING_STARTED_CHAPTERS.findIndex((item) => item.id === state.activeChapter);
  return GETTING_STARTED_CHAPTERS[index + 1]?.id ?? "ready";
}

/** Only app-observed, scoped results count as task completion; model prose has no authority. */
export function reduceGettingStarted(
  state: GettingStartedProgress,
  event: GettingStartedEvent,
): GettingStartedProgress {
  if (event.generation !== undefined && event.generation !== state.generation) return state;
  if (event.fromChapter !== undefined && event.fromChapter !== state.activeChapter) return state;
  switch (event.type) {
    case "start":
      if (state.environmentId !== null && state.environmentId !== event.environmentId) {
        return {
          ...DEFAULT_GETTING_STARTED_PROGRESS,
          generation: state.generation + 1,
          environmentId: event.environmentId,
          startedAt: event.at,
          open: true,
        };
      }
      return {
        ...state,
        generation: state.startedAt === null ? state.generation + 1 : state.generation,
        environmentId: event.environmentId,
        startedAt: state.startedAt ?? event.at,
        open: true,
        paused: false,
      };
    case "restart":
      return {
        ...DEFAULT_GETTING_STARTED_PROGRESS,
        generation: state.generation + 1,
        environmentId: state.environmentId,
        startedAt: state.startedAt,
        open: true,
      };
    case "select":
      return { ...state, activeChapter: event.chapter, open: true, paused: false };
    case "close":
      return { ...state, open: false };
    case "pause":
      return { ...state, open: false, paused: true };
    case "next":
      return { ...state, activeChapter: nextChapter(state), open: true, paused: false };
    case "later":
      return {
        ...state,
        deferred:
          state.completed.includes(state.activeChapter) ||
          state.deferred.includes(state.activeChapter)
            ? state.deferred
            : [...state.deferred, state.activeChapter],
        activeChapter: nextChapter(state),
        open: true,
        paused: false,
      };
    case "acknowledge": {
      if (state.startedAt === null || state.activeChapter !== event.chapter) return state;
      const completed = complete(state, event.chapter);
      if (event.continue === "next")
        return { ...completed, activeChapter: nextChapter(completed), open: true, paused: false };
      if (event.continue === "pause") return { ...completed, open: false, paused: true };
      return completed;
    }
    case "connection-ready":
      return state.startedAt !== null &&
        state.environmentId === event.environmentId &&
        state.activeChapter === "connect"
        ? complete(state, "connect")
        : state;
    case "track": {
      if (state.startedAt === null || event.environmentId !== state.environmentId) return state;
      if (!TASK_CHAPTERS.has(event.chapter)) return state;
      const previous = state.tasks.find((task) => task.chapter === event.chapter);
      if (previous?.environmentId === event.environmentId && previous.threadId === event.threadId)
        return state;
      return {
        ...state,
        tasks: [
          ...state.tasks.filter((task) => task.chapter !== event.chapter),
          {
            chapter: event.chapter,
            environmentId: event.environmentId,
            threadId: event.threadId,
            after: event.at,
            messageIds: [],
            toolNames: event.toolNames ?? [],
            runIds: [],
            checkedSource: false,
          },
        ],
      };
    }
    case "submitted": {
      let changed = false;
      const tasks = state.tasks.map((task) => {
        if (
          task.environmentId !== event.environmentId ||
          task.threadId !== event.threadId ||
          task.messageIds.includes(event.messageId) ||
          state.completed.includes(task.chapter) ||
          task.runIds.length >= 2
        )
          return task;
        changed = true;
        return { ...task, messageIds: [...task.messageIds, event.messageId].slice(-32) };
      });
      return changed ? { ...state, tasks } : state;
    }
    case "checked-source": {
      const task = state.tasks.find(
        (item) =>
          item.chapter === "conversation" &&
          item.environmentId === event.environmentId &&
          item.threadId === event.threadId,
      );
      if (!task || task.runIds.length < 2 || task.checkedSource) return state;
      return complete(
        {
          ...state,
          tasks: state.tasks.map((item) =>
            item === task ? { ...item, checkedSource: true } : item,
          ),
        },
        "conversation",
      );
    }
    case "run": {
      if (!event.succeeded || !event.hasAnswer || state.environmentId !== event.environmentId)
        return state;
      let changed = false;
      const newlyCompleted: GettingStartedChapterId[] = [];
      const tasks = state.tasks.map((task) => {
        if (!TASK_CHAPTERS.has(task.chapter)) return task;
        if (state.completed.includes(task.chapter) || task.runIds.length >= 2) return task;
        if (
          task.environmentId !== event.environmentId ||
          task.threadId !== event.threadId ||
          task.runIds.includes(event.runId)
        )
          return task;
        if (event.userMessageId !== undefined && !task.messageIds.includes(event.userMessageId))
          return task;
        const runTime = Date.parse(event.startedAt);
        const after = Date.parse(task.after);
        if (
          event.userMessageId === undefined &&
          (!Number.isFinite(runTime) || !Number.isFinite(after) || runTime < after)
        )
          return task;
        // A connected-work task prepared without email tools is the sample-email practice.
        if (
          task.chapter === "connected-work" &&
          task.toolNames.length > 0 &&
          !event.connectedToolSucceeded
        )
          return task;
        if (task.chapter === "files" && !event.usedFile) return task;
        if (task.chapter === "approvals" && !event.answeredApproval) return task;
        if (task.chapter === "skills" && !event.usedSkill) return task;
        changed = true;
        if (task.chapter !== "conversation") newlyCompleted.push(task.chapter);
        return { ...task, runIds: [...task.runIds, event.runId].slice(-2) };
      });
      return changed
        ? {
            ...state,
            tasks,
            completed: [...state.completed, ...newlyCompleted],
            deferred: state.deferred.filter((chapter) => !newlyCompleted.includes(chapter)),
          }
        : state;
    }
  }
}

/** Usage events for one saved progress change: a first start, and chapters newly finished or saved for later. */
export function gettingStartedAnalyticsEvents(
  before: GettingStartedProgress,
  after: GettingStartedProgress,
): GettingStartedAnalyticsInput[] {
  const events: GettingStartedAnalyticsInput[] = [];
  if (before.startedAt === null && after.startedAt !== null) events.push({ event: "started" });
  for (const chapter of after.completed) {
    if (!before.completed.includes(chapter)) events.push({ event: "chapter-completed", chapter });
  }
  for (const chapter of after.deferred) {
    if (!before.deferred.includes(chapter)) events.push({ event: "chapter-later", chapter });
  }
  return events;
}
