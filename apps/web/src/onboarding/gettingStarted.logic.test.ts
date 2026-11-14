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

import {
  gettingStartedAnalyticsEvents,
  gettingStartedSkillRecipes,
  reduceGettingStarted,
  type GettingStartedEvent,
} from "./gettingStarted.logic";

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

function tracked(chapter: GettingStartedChapterId, toolNames: ReadonlyArray<string> = []) {
  return apply(
    start(),
    { type: "select", chapter },
    {
      type: "track",
      chapter,
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      at: TRACKED_AT,
      toolNames,
    },
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
    answeredApproval: false,
    usedSkill: false,
    ...overrides,
  };
}

const checkedSource = {
  type: "checked-source",
  environmentId: ENVIRONMENT,
  threadId: THREAD,
} as const satisfies GettingStartedEvent;

describe("getting started persistence", () => {
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
});

describe("atomic chapter continuations", () => {
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
});

describe("doing useful work", () => {
  it.each([
    {
      chapter: "connected-work",
      toolNames: ["microsoft365_mail_search"],
      evidence: { connectedToolSucceeded: true },
    },
    { chapter: "files", toolNames: [], evidence: { usedFile: true } },
    { chapter: "approvals", toolNames: [], evidence: { answeredApproval: true } },
    { chapter: "skills", toolNames: [], evidence: { usedSkill: true } },
  ] as const)(
    "rejected $chapter evidence does not consume the run id",
    ({ chapter, toolNames, evidence }) => {
      const progress = tracked(chapter, toolNames);
      const incomplete = reduceGettingStarted(progress, successfulRun());

      expect(incomplete).toEqual(progress);
      const completed = reduceGettingStarted(incomplete, successfulRun(evidence));
      expect(completed.completed).toEqual([chapter]);
      expect(completed.tasks[0]?.runIds).toEqual(["first-run"]);
      expect(
        reduceGettingStarted(completed, successfulRun({ runId: "late-extra", ...evidence })),
      ).toEqual(completed);
    },
  );
});

describe("practice without a connected account", () => {
  it("completes connected work from the sample-email draft, which declares no email tools", () => {
    expect(reduceGettingStarted(tracked("connected-work"), successfulRun()).completed).toEqual([
      "connected-work",
    ]);
  });
});

describe("usage events", () => {
  it("reports a first start and each chapter newly finished or saved for later", () => {
    const started = start();
    const deferred = reduceGettingStarted(started, { type: "later" });
    const restarted = reduceGettingStarted(deferred, { type: "restart" });

    expect(gettingStartedAnalyticsEvents(DEFAULT_GETTING_STARTED_PROGRESS, started)).toEqual([
      { event: "started" },
    ]);
    expect(gettingStartedAnalyticsEvents(started, deferred)).toEqual([
      { event: "chapter-later", chapter: "welcome" },
    ]);
    expect(gettingStartedAnalyticsEvents(started, { ...started, completed: ["welcome"] })).toEqual([
      { event: "chapter-completed", chapter: "welcome" },
    ]);
    expect(gettingStartedAnalyticsEvents(deferred, restarted)).toEqual([]);
  });
});

describe("starter skill recipes", () => {
  it("offers everyday recipes the person can run now, best first", () => {
    const recipes = gettingStartedSkillRecipes(
      new Set(["skill-creator", "gmail", "google-calendar", "outlook-mail", "outlook-calendar"]),
      new Map([
        ["google-workspace", new Set(["gmail", "google-calendar"])],
        ["microsoft-365", new Set<string>()],
      ]),
    );

    expect(recipes.map(({ id, prompt }) => [id, prompt.split(" Give")[0]])).toEqual([
      ["morning-brief", "$google-calendar $gmail"],
      ["make-a-skill", expect.stringMatching(/^\$skill-creator /)],
    ]);
  });
});
