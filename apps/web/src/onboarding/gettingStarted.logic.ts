import {
  DEFAULT_GETTING_STARTED_PROGRESS,
  type EnvironmentId,
  type GettingStartedChapterId,
  type GettingStartedProgress,
  type ThreadId,
} from "@t3tools/contracts";

export const GETTING_STARTED_CHAPTERS = [
  { id: "welcome", title: "Meet your assistant", description: "See what it can help you do." },
  { id: "conversation", title: "Talk to AI", description: "Ask, follow up, and check an answer." },
  {
    id: "connect",
    title: "Connect your work",
    description: "Connect Outlook or Gmail on your terms.",
  },
  { id: "connected-work", title: "Try connected work", description: "Put your connection to use." },
  { id: "files", title: "Use files & projects", description: "Give it material to work with." },
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
      if (!["conversation", "connected-work", "files", "ideas"].includes(event.chapter))
        return state;
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
        if (!["conversation", "connected-work", "files", "ideas"].includes(task.chapter))
          return task;
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
        if (task.chapter === "connected-work" && !event.connectedToolSucceeded) return task;
        if (task.chapter === "files" && !event.usedFile) return task;
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
