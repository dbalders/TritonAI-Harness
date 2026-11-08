import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_GETTING_STARTED_PROGRESS,
  EnvironmentId,
  ThreadId,
  type GettingStartedChapterId,
  type GettingStartedProgress,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { reduceGettingStarted, type GettingStartedEvent } from "./gettingStarted.logic";

const ENVIRONMENT = EnvironmentId.make("getting-started-local");
const OTHER_ENVIRONMENT = EnvironmentId.make("getting-started-remote");
const THREAD = ThreadId.make("getting-started-practice");
const OTHER_THREAD = ThreadId.make("getting-started-other");
const STARTED_AT = "2026-10-22T10:00:00.000Z";
const TRACKED_AT = "2026-10-22T10:01:00.000Z";
const FIRST_RUN_AT = "2026-10-22T10:02:00.000Z";
const FOLLOW_UP_AT = "2026-10-22T10:03:00.000Z";
const RETRIED_AT = "2026-10-22T10:04:00.000Z";
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
type RunEvent = Extract<GettingStartedEvent, { type: "run" }>;

function apply(state: GettingStartedProgress, ...events: GettingStartedEvent[]) {
  return events.reduce(reduceGettingStarted, state);
}

function start() {
  return reduceGettingStarted(DEFAULT_GETTING_STARTED_PROGRESS, {
    type: "start",
    environmentId: ENVIRONMENT,
    at: STARTED_AT,
  });
}

function tracked(chapter: GettingStartedChapterId) {
  return apply(
    start(),
    { type: "select", chapter },
    { type: "track", chapter, environmentId: ENVIRONMENT, threadId: THREAD, at: TRACKED_AT },
  );
}

function successfulRun(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    type: "run",
    environmentId: ENVIRONMENT,
    threadId: THREAD,
    runId: "first-run",
    startedAt: FIRST_RUN_AT,
    succeeded: true,
    hasAnswer: true,
    connectedToolSucceeded: false,
    usedFile: false,
    ...overrides,
  };
}

const checkedSource = {
  type: "checked-source",
  environmentId: ENVIRONMENT,
  threadId: THREAD,
} as const satisfies GettingStartedEvent;

describe("getting started persistence", () => {
  it("decodes existing settings defaults to an empty, closed guide", () => {
    const { gettingStarted: _guide, ...existingDefaults } =
      encodeClientSettings(DEFAULT_CLIENT_SETTINGS);
    const decoded = decodeClientSettings(existingDefaults);

    expect(decoded.gettingStarted).toEqual({
      generation: 0,
      startedAt: null,
      environmentId: null,
      activeChapter: "welcome",
      open: false,
      paused: false,
      completed: [],
      deferred: [],
      tasks: [],
    });
    expect(decoded).toEqual(DEFAULT_CLIENT_SETTINGS);
    expect(decodeClientSettings({})).toEqual(decoded);
  });

  it("preserves existing preferences and wizard history when the guide field is absent", () => {
    const preferences = {
      diffLayout: "split",
      fontSizePrompt: 18,
      confirmThreadDelete: false,
      tritonAiFirstRunOnboardingCompleted: true,
      onboardingCompletedAt: "2026-09-01T10:00:00.000Z",
      experimentalGuidedTourEnabled: true,
      followUpBehavior: "steer",
    };
    const decoded = decodeClientSettings(preferences);

    expect(decoded).toMatchObject(preferences);
    expect(decoded.gettingStarted).toEqual(DEFAULT_GETTING_STARTED_PROGRESS);
    expect(decoded.gettingStarted.startedAt).toBeNull();
  });

  it("retains older saved task evidence when generation and submitted-message fields are absent", () => {
    const progress = apply(tracked("conversation"), successfulRun());
    const { generation: _generation, ...legacyProgress } = progress;
    const tasks = legacyProgress.tasks.map(({ messageIds: _messageIds, ...task }) => task);
    const restored = decodeClientSettings({ gettingStarted: { ...legacyProgress, tasks } });

    expect(restored.gettingStarted).toEqual({ ...progress, generation: 0 });
    expect(restored.gettingStarted.tasks[0]?.runIds).toEqual(["first-run"]);
  });

  it("round-trips completed, deferred, and tracked work with unrelated settings intact", () => {
    const conversation = apply(
      start(),
      { type: "acknowledge", chapter: "welcome" },
      { type: "select", chapter: "conversation" },
      {
        type: "track",
        chapter: "conversation",
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        at: TRACKED_AT,
      },
      {
        type: "submitted",
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        messageId: "practice-message",
      },
      successfulRun({ userMessageId: "practice-message" }),
      {
        type: "submitted",
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        messageId: "follow-up-message",
      },
      successfulRun({
        runId: "follow-up",
        startedAt: FOLLOW_UP_AT,
        userMessageId: "follow-up-message",
      }),
      checkedSource,
      { type: "select", chapter: "connect" },
      { type: "later" },
      { type: "select", chapter: "ideas" },
      {
        type: "track",
        chapter: "ideas",
        environmentId: ENVIRONMENT,
        threadId: OTHER_THREAD,
        at: RETRIED_AT,
      },
      { type: "pause" },
    );
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      diffLayout: "split" as const,
      tritonAiFirstRunOnboardingCompleted: true,
      gettingStarted: conversation,
    };
    const restored = decodeClientSettings(
      JSON.parse(JSON.stringify(encodeClientSettings(settings))),
    );

    expect(restored).toEqual(settings);
    expect(restored.gettingStarted).toMatchObject({
      activeChapter: "ideas",
      completed: ["welcome", "conversation"],
      deferred: ["connect"],
      paused: true,
      open: false,
      tasks: [
        {
          chapter: "conversation",
          messageIds: ["practice-message", "follow-up-message"],
          runIds: ["first-run", "follow-up"],
          checkedSource: true,
        },
        { chapter: "ideas", threadId: OTHER_THREAD, runIds: [], checkedSource: false },
      ],
    });
    expect(
      reduceGettingStarted(restored.gettingStarted, {
        type: "start",
        environmentId: ENVIRONMENT,
        at: RETRIED_AT,
      }),
    ).toEqual({ ...conversation, open: true, paused: false });
  });
});

describe("guide navigation and recovery", () => {
  it("pauses and resumes at the same chapter without losing task evidence", () => {
    const progress = apply(tracked("conversation"), successfulRun());
    const paused = reduceGettingStarted(progress, { type: "pause" });

    expect(paused).toEqual({ ...progress, open: false, paused: true });
    expect(
      reduceGettingStarted(paused, { type: "start", environmentId: ENVIRONMENT, at: RETRIED_AT }),
    ).toEqual({ ...progress, open: true, paused: false });
    expect(reduceGettingStarted(paused, { type: "select", chapter: "conversation" })).toEqual({
      ...progress,
      open: true,
      paused: false,
    });
  });

  it("closing the guide neither pauses it nor defers or completes the chapter", () => {
    const progress = tracked("ideas");

    expect(reduceGettingStarted(progress, { type: "close" })).toEqual({ ...progress, open: false });
    expect(progress.paused).toBe(false);
    expect(progress.completed).toEqual([]);
    expect(progress.deferred).toEqual([]);
  });

  it("later remembers an unfinished chapter and moves on without claiming completion", () => {
    const progress = apply(tracked("conversation"), successfulRun());
    const later = reduceGettingStarted(progress, { type: "later" });

    expect(later).toMatchObject({
      activeChapter: "connect",
      deferred: ["conversation"],
      completed: [],
      open: true,
    });
    expect(later.tasks).toEqual(progress.tasks);
    const deferredAgain = apply(
      later,
      { type: "select", chapter: "conversation" },
      { type: "later" },
    );
    expect(deferredAgain.deferred).toEqual(["conversation"]);
  });

  it("next and selecting chapters do not substitute for doing their work", () => {
    const next = reduceGettingStarted(start(), { type: "next" });
    const ready = reduceGettingStarted(next, { type: "select", chapter: "ready" });

    expect(next.activeChapter).toBe("conversation");
    expect(ready.completed).toEqual([]);
    expect(ready.deferred).toEqual([]);
    expect(reduceGettingStarted(ready, { type: "next" }).activeChapter).toBe("ready");
  });

  it("restart clears completion, deferrals, and in-flight work while retaining the environment", () => {
    const progress = apply(
      tracked("ideas"),
      successfulRun(),
      { type: "select", chapter: "connect" },
      { type: "later" },
      { type: "pause" },
    );
    const restarted = reduceGettingStarted(progress, { type: "restart" });

    expect(restarted).toMatchObject({
      environmentId: ENVIRONMENT,
      activeChapter: "welcome",
      open: true,
      paused: false,
      completed: [],
      deferred: [],
      tasks: [],
    });
    expect(apply(restarted, successfulRun(), checkedSource)).toEqual(restarted);
  });

  it("changing environment clears all old evidence, even when thread ids coincide", () => {
    const progress = apply(
      tracked("conversation"),
      successfulRun(),
      successfulRun({ runId: "follow-up" }),
      checkedSource,
      { type: "select", chapter: "files" },
      { type: "later" },
      { type: "pause" },
    );
    const switched = reduceGettingStarted(progress, {
      type: "start",
      environmentId: OTHER_ENVIRONMENT,
      at: RETRIED_AT,
    });

    expect(switched).toEqual({
      ...DEFAULT_GETTING_STARTED_PROGRESS,
      generation: progress.generation + 1,
      environmentId: OTHER_ENVIRONMENT,
      startedAt: RETRIED_AT,
      open: true,
    });
    const remoteTask = reduceGettingStarted(switched, {
      type: "track",
      chapter: "conversation",
      environmentId: OTHER_ENVIRONMENT,
      threadId: THREAD,
      at: RETRIED_AT,
    });
    expect(apply(remoteTask, successfulRun(), checkedSource)).toEqual(remoteTask);
    expect(
      reduceGettingStarted(remoteTask, {
        type: "start",
        environmentId: ENVIRONMENT,
        at: RETRIED_AT,
      }).tasks,
    ).toEqual([]);
  });

  it("acknowledgements and connection readiness require the current started chapter", () => {
    expect(
      reduceGettingStarted(DEFAULT_GETTING_STARTED_PROGRESS, {
        type: "acknowledge",
        chapter: "welcome",
      }),
    ).toEqual(DEFAULT_GETTING_STARTED_PROGRESS);
    expect(reduceGettingStarted(start(), { type: "acknowledge", chapter: "ready" })).toEqual(
      start(),
    );
    expect(
      reduceGettingStarted(start(), { type: "connection-ready", environmentId: ENVIRONMENT }),
    ).toEqual(start());
    const connect = reduceGettingStarted(start(), { type: "select", chapter: "connect" });
    expect(
      reduceGettingStarted(connect, { type: "connection-ready", environmentId: OTHER_ENVIRONMENT }),
    ).toEqual(connect);
    expect(
      reduceGettingStarted(connect, { type: "connection-ready", environmentId: ENVIRONMENT })
        .completed,
    ).toEqual(["connect"]);
  });
});

describe("atomic chapter continuations", () => {
  it("acknowledges welcome and advances in one transition", () => {
    const progress = start();
    const continued = reduceGettingStarted(progress, {
      type: "acknowledge",
      chapter: "welcome",
      continue: "next",
      generation: progress.generation,
      fromChapter: "welcome",
    });

    expect(continued).toMatchObject({
      completed: ["welcome"],
      activeChapter: "conversation",
      open: true,
      paused: false,
    });
    expect(continued.tasks).toEqual(progress.tasks);
  });

  it("acknowledges the final chapter and pauses without losing completed work", () => {
    const progress = apply(tracked("ideas"), successfulRun(), {
      type: "select",
      chapter: "ready",
    });
    const paused = reduceGettingStarted(progress, {
      type: "acknowledge",
      chapter: "ready",
      continue: "pause",
      generation: progress.generation,
      fromChapter: "ready",
    });

    expect(paused).toMatchObject({
      activeChapter: "ready",
      completed: ["ideas", "ready"],
      open: false,
      paused: true,
    });
    expect(paused.tasks).toEqual(progress.tasks);
  });

  it.each(["next", "pause"] as const)(
    "ignores a delayed %s acknowledgement after the user selects another chapter",
    (continuation) => {
      const origin = start();
      const selected = reduceGettingStarted(origin, { type: "select", chapter: "files" });

      expect(
        reduceGettingStarted(selected, {
          type: "acknowledge",
          chapter: "welcome",
          continue: continuation,
          generation: origin.generation,
          fromChapter: "welcome",
        }),
      ).toBe(selected);
    },
  );

  it.each(["next", "pause"] as const)(
    "ignores a delayed %s acknowledgement after restarting at the same chapter",
    (continuation) => {
      const origin = start();
      const restarted = reduceGettingStarted(origin, { type: "restart" });

      expect(restarted.activeChapter).toBe(origin.activeChapter);
      expect(restarted.generation).toBeGreaterThan(origin.generation);
      expect(
        reduceGettingStarted(restarted, {
          type: "acknowledge",
          chapter: "welcome",
          continue: continuation,
          generation: origin.generation,
          fromChapter: "welcome",
        }),
      ).toBe(restarted);
    },
  );

  it.each<GettingStartedEvent>([
    { type: "close" },
    { type: "pause" },
    { type: "next" },
    { type: "select", chapter: "ideas" },
    {
      type: "track",
      chapter: "conversation",
      environmentId: ENVIRONMENT,
      threadId: OTHER_THREAD,
      at: RETRIED_AT,
    },
  ])("ignores a late $type from the chapter the user left", (event) => {
    const origin = tracked("conversation");
    const selected = reduceGettingStarted(origin, { type: "select", chapter: "files" });

    expect(
      reduceGettingStarted(selected, {
        ...event,
        generation: origin.generation,
        fromChapter: "conversation",
      }),
    ).toBe(selected);
  });
});

describe("scoped run evidence", () => {
  it.each([
    { reason: "a run started before tracking", change: { startedAt: STARTED_AT } },
    // Failed and cancelled provider outcomes both normalize to succeeded: false.
    { reason: "a failed run with partial answer text", change: { succeeded: false } },
    { reason: "a cancelled run with partial answer text", change: { succeeded: false } },
    { reason: "a successful run without an answer", change: { hasAnswer: false } },
    { reason: "another thread's successful run", change: { threadId: OTHER_THREAD } },
    {
      reason: "another environment's successful run",
      change: { environmentId: OTHER_ENVIRONMENT },
    },
    { reason: "an invalid run timestamp", change: { startedAt: "not-a-timestamp" } },
  ])("does not count $reason", ({ change }) => {
    const progress = tracked("ideas");

    expect(reduceGettingStarted(progress, successfulRun(change))).toEqual(progress);
    expect(progress.completed).toEqual([]);
  });

  it("does not count a successful historical run seen before any task was tracked", () => {
    const progress = start();

    expect(reduceGettingStarted(progress, successfulRun())).toEqual(progress);
    expect(
      reduceGettingStarted(DEFAULT_GETTING_STARTED_PROGRESS, {
        type: "track",
        chapter: "ideas",
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        at: TRACKED_AT,
      }),
    ).toEqual(DEFAULT_GETTING_STARTED_PROGRESS);
  });

  it("rejects tracking in another environment and cannot count an invalid tracking time", () => {
    const progress = start();
    expect(
      reduceGettingStarted(progress, {
        type: "track",
        chapter: "ideas",
        environmentId: OTHER_ENVIRONMENT,
        threadId: THREAD,
        at: TRACKED_AT,
      }),
    ).toEqual(progress);
    const invalid = reduceGettingStarted(progress, {
      type: "track",
      chapter: "ideas",
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      at: "invalid",
    });
    expect(reduceGettingStarted(invalid, successfulRun())).toEqual(invalid);
  });

  it("accepts a run starting at the tracking boundary, including a different timezone spelling", () => {
    const result = reduceGettingStarted(
      tracked("ideas"),
      successfulRun({
        startedAt: "2026-10-22T03:01:00.000-07:00",
      }),
    );

    expect(result.completed).toEqual(["ideas"]);
  });

  it("retracking the same draft does not erase a completed first conversation turn", () => {
    const progress = apply(tracked("conversation"), successfulRun());

    expect(
      reduceGettingStarted(progress, {
        type: "track",
        chapter: "conversation",
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        at: RETRIED_AT,
      }),
    ).toEqual(progress);
  });

  it("replacing a tracked thread clears its evidence and ignores late results from the old thread", () => {
    const progress = apply(tracked("conversation"), successfulRun());
    const replacement = reduceGettingStarted(progress, {
      type: "track",
      chapter: "conversation",
      environmentId: ENVIRONMENT,
      threadId: OTHER_THREAD,
      at: RETRIED_AT,
    });

    expect(replacement.tasks).toMatchObject([
      { threadId: OTHER_THREAD, runIds: [], checkedSource: false, after: RETRIED_AT },
    ]);
    expect(
      apply(
        replacement,
        successfulRun({ runId: "late-result", startedAt: RETRIED_AT }),
        checkedSource,
      ),
    ).toEqual(replacement);
    expect(
      reduceGettingStarted(
        replacement,
        successfulRun({ threadId: OTHER_THREAD, startedAt: RETRIED_AT }),
      ).tasks[0]?.runIds,
    ).toEqual(["first-run"]);
  });

  it("a restarted task in the same thread cannot reuse a result from before the new attempt", () => {
    const restarted = apply(
      tracked("conversation"),
      successfulRun(),
      { type: "restart" },
      {
        type: "track",
        chapter: "conversation",
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        at: RETRIED_AT,
      },
    );

    expect(apply(restarted, successfulRun(), checkedSource)).toEqual(restarted);
    expect(
      reduceGettingStarted(
        restarted,
        successfulRun({ runId: "new-attempt", startedAt: RETRIED_AT }),
      ).tasks[0]?.runIds,
    ).toEqual(["new-attempt"]);
  });

  it("a late result can complete its deferred chapter without moving the current chapter", () => {
    const deferred = reduceGettingStarted(tracked("ideas"), { type: "later" });
    const completed = reduceGettingStarted(deferred, successfulRun());

    expect(completed.activeChapter).toBe("computer-use");
    expect(completed.completed).toEqual(["ideas"]);
    expect(completed.deferred).toEqual([]);
  });

  it("only submitted messages in the tracked thread and environment can bind a run", () => {
    const progress = tracked("ideas");
    const submitted = {
      type: "submitted",
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      messageId: "draft-message",
    } as const satisfies GettingStartedEvent;
    expect(
      reduceGettingStarted(progress, { ...submitted, environmentId: OTHER_ENVIRONMENT }),
    ).toEqual(progress);
    expect(reduceGettingStarted(progress, { ...submitted, threadId: OTHER_THREAD })).toEqual(
      progress,
    );
    expect(
      reduceGettingStarted(progress, successfulRun({ userMessageId: "untracked-message" })),
    ).toEqual(progress);
    const pending = reduceGettingStarted(progress, submitted);

    expect(pending.completed).toEqual([]);
    expect(pending.tasks[0]?.messageIds).toEqual(["draft-message"]);
    expect(reduceGettingStarted(pending, submitted)).toEqual(pending);
    expect(
      reduceGettingStarted(pending, successfulRun({ userMessageId: "untracked-message" })),
    ).toEqual(pending);
    expect(
      reduceGettingStarted(pending, successfulRun({ userMessageId: "draft-message" })).completed,
    ).toEqual(["ideas"]);
  });

  it("rejects callbacks from a previous attempt even with the same thread and a recent timestamp", () => {
    const previous = tracked("conversation");
    const restarted = apply(
      previous,
      { type: "restart" },
      {
        type: "track",
        chapter: "conversation",
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        at: RETRIED_AT,
      },
    );
    const staleRun = successfulRun({
      startedAt: RETRIED_AT,
      generation: previous.generation,
    });

    expect(restarted.generation).toBeGreaterThan(previous.generation);
    expect(reduceGettingStarted(restarted, staleRun)).toEqual(restarted);
    expect(
      reduceGettingStarted(restarted, {
        type: "submitted",
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        messageId: "old-message",
        generation: previous.generation,
      }),
    ).toEqual(restarted);
    expect(
      reduceGettingStarted(restarted, {
        type: "track",
        chapter: "conversation",
        environmentId: ENVIRONMENT,
        threadId: OTHER_THREAD,
        at: RETRIED_AT,
        generation: previous.generation,
      }),
    ).toEqual(restarted);
    expect(
      reduceGettingStarted(restarted, { ...staleRun, generation: restarted.generation }).tasks[0]
        ?.runIds,
    ).toEqual(["first-run"]);
  });

  it("stale source checks and connection receipts cannot complete a restarted guide", () => {
    const previous = tracked("conversation");
    const ready = apply(
      previous,
      { type: "restart" },
      {
        type: "track",
        chapter: "conversation",
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        at: TRACKED_AT,
      },
      successfulRun(),
      successfulRun({ runId: "follow-up" }),
    );

    expect(
      reduceGettingStarted(ready, { ...checkedSource, generation: previous.generation }),
    ).toEqual(ready);
    expect(
      reduceGettingStarted(ready, { ...checkedSource, generation: ready.generation }).completed,
    ).toEqual(["conversation"]);
    const connect = reduceGettingStarted(ready, { type: "select", chapter: "connect" });
    expect(
      reduceGettingStarted(connect, {
        type: "connection-ready",
        environmentId: ENVIRONMENT,
        generation: previous.generation,
      }),
    ).toEqual(connect);
    expect(
      reduceGettingStarted(connect, {
        type: "connection-ready",
        environmentId: ENVIRONMENT,
        generation: connect.generation,
      }).completed,
    ).toEqual(["connect"]);
  });
});

describe("conversation practice", () => {
  it("requires two distinct successful runs followed by an explicit source check", () => {
    const progress = tracked("conversation");
    expect(reduceGettingStarted(progress, checkedSource)).toEqual(progress);
    const first = reduceGettingStarted(progress, successfulRun());
    expect(first.completed).toEqual([]);
    expect(reduceGettingStarted(first, checkedSource)).toEqual(first);
    expect(reduceGettingStarted(first, successfulRun())).toEqual(first);
    const second = reduceGettingStarted(
      first,
      successfulRun({ runId: "follow-up", startedAt: FOLLOW_UP_AT }),
    );

    expect(second.tasks[0]).toMatchObject({
      runIds: ["first-run", "follow-up"],
      checkedSource: false,
    });
    expect(second.completed).toEqual([]);
    const checked = reduceGettingStarted(second, checkedSource);
    expect(checked.completed).toEqual(["conversation"]);
    expect(checked.tasks[0]?.checkedSource).toBe(true);
    expect(reduceGettingStarted(checked, checkedSource)).toEqual(checked);
  });

  it.each([
    { reason: "failed", change: { succeeded: false } },
    { reason: "cancelled", change: { succeeded: false } },
    { reason: "answerless", change: { hasAnswer: false } },
    { reason: "historical", change: { startedAt: STARTED_AT } },
    { reason: "another thread's", change: { threadId: OTHER_THREAD } },
    { reason: "another environment's", change: { environmentId: OTHER_ENVIRONMENT } },
  ])("a $reason follow-up cannot unlock the source check", ({ change }) => {
    const first = apply(tracked("conversation"), successfulRun());

    expect(apply(first, successfulRun({ runId: "follow-up", ...change }), checkedSource)).toEqual(
      first,
    );
  });

  it("source checks from another thread or environment cannot complete the conversation", () => {
    const progress = apply(
      tracked("conversation"),
      successfulRun(),
      successfulRun({ runId: "follow-up" }),
    );

    expect(reduceGettingStarted(progress, { ...checkedSource, threadId: OTHER_THREAD })).toEqual(
      progress,
    );
    expect(
      reduceGettingStarted(progress, { ...checkedSource, environmentId: OTHER_ENVIRONMENT }),
    ).toEqual(progress);
    expect(reduceGettingStarted(progress, checkedSource).completed).toEqual(["conversation"]);
  });

  it("finishing deferred practice removes the deferral without duplicating completion", () => {
    const deferred = apply(tracked("conversation"), { type: "later" });
    const completed = apply(
      deferred,
      successfulRun(),
      successfulRun({ runId: "follow-up" }),
      checkedSource,
    );

    expect(completed.completed).toEqual(["conversation"]);
    expect(completed.deferred).toEqual([]);
    expect(
      apply(completed, { type: "select", chapter: "conversation" }, { type: "later" }).deferred,
    ).toEqual([]);
  });
});

describe("doing useful work", () => {
  it("opening and tracking an Ideas draft leaves the chapter unfinished until its own run succeeds", () => {
    const selected = reduceGettingStarted(start(), { type: "select", chapter: "ideas" });
    const draft = tracked("ideas");

    expect(selected.completed).toEqual([]);
    expect(draft.tasks[0]?.runIds).toEqual([]);
    expect(draft.completed).toEqual([]);
    expect(reduceGettingStarted(draft, successfulRun({ threadId: OTHER_THREAD }))).toEqual(draft);
    expect(reduceGettingStarted(draft, successfulRun()).completed).toEqual(["ideas"]);
  });

  it("connected work requires a successful integration tool result as well as a successful answer", () => {
    const progress = tracked("connected-work");

    // An ordinary chat answer, a connected account, or an attempted/failed tool call
    // does not supply the app-observed connectedToolSucceeded flag.
    expect(reduceGettingStarted(progress, successfulRun())).toEqual(progress);
    expect(
      reduceGettingStarted(
        progress,
        successfulRun({ connectedToolSucceeded: true, succeeded: false }),
      ),
    ).toEqual(progress);
    expect(
      reduceGettingStarted(
        progress,
        successfulRun({ connectedToolSucceeded: true, hasAnswer: false }),
      ),
    ).toEqual(progress);
    expect(reduceGettingStarted(progress, successfulRun({ usedFile: true }))).toEqual(progress);
    const completed = reduceGettingStarted(
      progress,
      successfulRun({ connectedToolSucceeded: true }),
    );
    expect(completed.completed).toEqual(["connected-work"]);
  });

  it("files requires attachment or file-work evidence rather than an ordinary chat answer", () => {
    const progress = tracked("files");

    expect(reduceGettingStarted(progress, successfulRun())).toEqual(progress);
    expect(reduceGettingStarted(progress, successfulRun({ connectedToolSucceeded: true }))).toEqual(
      progress,
    );
    expect(
      reduceGettingStarted(progress, successfulRun({ usedFile: true, succeeded: false })),
    ).toEqual(progress);
    expect(
      reduceGettingStarted(progress, successfulRun({ usedFile: true, hasAnswer: false })),
    ).toEqual(progress);
    expect(reduceGettingStarted(progress, successfulRun({ usedFile: true })).completed).toEqual([
      "files",
    ]);
  });

  it.each(["conversation", "connected-work", "files", "ideas"] as const)(
    "replaying the same successful run for %s is idempotent",
    (chapter) => {
      const event = successfulRun({ connectedToolSucceeded: true, usedFile: true });
      const completed = reduceGettingStarted(tracked(chapter), event);

      expect(reduceGettingStarted(completed, event)).toEqual(completed);
      expect(completed.tasks[0]?.runIds).toEqual(["first-run"]);
      expect(completed.completed).toEqual(chapter === "conversation" ? [] : [chapter]);
    },
  );

  it("replaying an older success remains idempotent after further distinct runs arrive", () => {
    const first = successfulRun();
    const progress = apply(
      tracked("conversation"),
      first,
      successfulRun({ runId: "second", startedAt: FOLLOW_UP_AT }),
      successfulRun({ runId: "third", startedAt: RETRIED_AT }),
    );

    expect(reduceGettingStarted(progress, first)).toEqual(progress);
    expect(reduceGettingStarted(progress, checkedSource).completed).toEqual(["conversation"]);
  });

  it("an initially unfinished run can count when its successful answer arrives later", () => {
    const progress = tracked("ideas");
    const pending = reduceGettingStarted(
      progress,
      successfulRun({ succeeded: false, hasAnswer: false }),
    );

    expect(pending).toEqual(progress);
    expect(reduceGettingStarted(pending, successfulRun()).completed).toEqual(["ideas"]);
  });

  it.each([
    { chapter: "connected-work", evidence: { connectedToolSucceeded: true } },
    { chapter: "files", evidence: { usedFile: true } },
  ] as const)("rejected $chapter evidence does not consume the run id", ({ chapter, evidence }) => {
    const progress = tracked(chapter);
    const incomplete = reduceGettingStarted(progress, successfulRun());

    expect(incomplete).toEqual(progress);
    const completed = reduceGettingStarted(incomplete, successfulRun(evidence));
    expect(completed.completed).toEqual([chapter]);
    expect(completed.tasks[0]?.runIds).toEqual(["first-run"]);
    expect(
      reduceGettingStarted(completed, successfulRun({ runId: "late-extra", ...evidence })),
    ).toEqual(completed);
  });
});
