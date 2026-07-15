import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  deriveDesktopNotificationIntents,
  desktopNotificationContent,
  desktopNotificationSummaryContent,
  getDesktopNotificationPermission,
  observeDesktopNotificationThreads,
  planDesktopNotificationDeliveries,
  showDesktopNotification,
  type DesktopNotificationIntent,
  type DesktopNotificationThreadMap,
  type DesktopNotificationThreadShellLike,
} from "./desktopNotifications";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeThread(
  overrides: Partial<DesktopNotificationThreadShellLike> = {},
): DesktopNotificationThreadShellLike {
  return {
    environmentId: ENVIRONMENT_A,
    id: THREAD_A,
    title: "Fix release workflow",
    archivedAt: null,
    session: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasActionableProposedPlan: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function threadMap(
  threads: ReadonlyArray<DesktopNotificationThreadShellLike>,
): DesktopNotificationThreadMap {
  return new Map(
    threads.map((thread) => [`${thread.environmentId}:${thread.id}`, thread] as const),
  );
}

function derive(
  previous: DesktopNotificationThreadShellLike,
  next: DesktopNotificationThreadShellLike,
): DesktopNotificationIntent[] {
  return deriveDesktopNotificationIntents(threadMap([previous]), threadMap([next]));
}

describe("deriveDesktopNotificationIntents", () => {
  it("does not notify for bootstrap state", () => {
    const next = makeThread({
      session: { status: "ready" },
      latestTurn: { state: "completed" },
    });
    expect(deriveDesktopNotificationIntents(new Map(), threadMap([next]))).toEqual([]);
  });

  it("notifies once when a running task completes", () => {
    const previous = makeThread({
      session: { status: "running" },
      latestTurn: { state: "running" },
    });
    const next = makeThread({
      session: { status: "ready" },
      latestTurn: { state: "completed" },
    });
    expect(derive(previous, next)).toEqual([
      {
        environmentId: ENVIRONMENT_A,
        threadId: THREAD_A,
        threadTitle: "Fix release workflow",
        kind: "completed",
      },
    ]);
    expect(derive(next, next)).toEqual([]);
  });

  it("classifies session and turn errors as failures", () => {
    const previous = makeThread({ session: { status: "running" } });
    expect(derive(previous, makeThread({ session: { status: "error" } }))[0]?.kind).toBe("failed");
    expect(
      derive(
        previous,
        makeThread({ session: { status: "ready" }, latestTurn: { state: "error" } }),
      )[0]?.kind,
    ).toBe("failed");
  });

  it("does not notify for interrupted work", () => {
    const previous = makeThread({ session: { status: "running" } });
    const next = makeThread({
      session: { status: "interrupted" },
      latestTurn: { state: "interrupted" },
    });
    expect(derive(previous, next)).toEqual([]);
  });

  it("does not report manually stopped work as completed", () => {
    const previous = makeThread({ session: { status: "running" } });
    const next = makeThread({ session: { status: "stopped" } });
    expect(derive(previous, next)).toEqual([]);
  });

  it("notifies when a task fails during startup", () => {
    const previous = makeThread({ session: { status: "starting" } });
    const next = makeThread({ session: { status: "error" } });
    expect(derive(previous, next)[0]?.kind).toBe("failed");
  });

  it("does not treat running to starting as completion", () => {
    const previous = makeThread({ session: { status: "running" } });
    const next = makeThread({ session: { status: "starting" } });
    expect(derive(previous, next)).toEqual([]);
  });

  it("uses session state as the completion edge instead of checkpoint turn state", () => {
    const previous = makeThread({
      session: { status: "running" },
      latestTurn: { state: "running" },
    });
    const checkpoint = makeThread({
      session: { status: "running" },
      latestTurn: { state: "completed" },
    });
    expect(derive(previous, checkpoint)).toEqual([]);
  });

  it("notifies on approval and actionable-plan rising edges", () => {
    const previous = makeThread();
    expect(derive(previous, makeThread({ hasPendingApprovals: true }))[0]?.kind).toBe("approval");
    expect(derive(previous, makeThread({ hasActionableProposedPlan: true }))[0]?.kind).toBe(
      "approval",
    );
  });

  it("does not repeat an approval while attention remains pending", () => {
    const previous = makeThread({ hasPendingApprovals: true });
    const next = makeThread({
      hasPendingApprovals: true,
      hasActionableProposedPlan: true,
    });
    expect(derive(previous, next)).toEqual([]);
  });

  it("notifies on a user-input rising edge and not while it remains pending", () => {
    const previous = makeThread();
    const pending = makeThread({ hasPendingUserInput: true });
    expect(derive(previous, pending)[0]?.kind).toBe("input");
    expect(derive(pending, pending)).toEqual([]);
  });

  it("prioritizes approval and input over a simultaneous turn end", () => {
    const previous = makeThread({ session: { status: "running" } });
    const approval = makeThread({
      session: { status: "ready" },
      latestTurn: { state: "completed" },
      hasPendingApprovals: true,
    });
    const input = makeThread({
      session: { status: "ready" },
      latestTurn: { state: "completed" },
      hasPendingUserInput: true,
    });
    expect(derive(previous, approval).map((intent) => intent.kind)).toEqual(["approval"]);
    expect(derive(previous, input).map((intent) => intent.kind)).toEqual(["input"]);
  });

  it("skips archived threads", () => {
    const previous = makeThread({ session: { status: "running" } });
    const next = makeThread({
      archivedAt: "2026-07-14T00:00:00.000Z",
      session: { status: "ready" },
    });
    expect(derive(previous, next)).toEqual([]);
  });

  it("keeps identical thread ids in different environments distinct", () => {
    const previousA = makeThread({ session: { status: "running" } });
    const previousB = makeThread({
      environmentId: ENVIRONMENT_B,
      session: { status: "running" },
    });
    const nextA = makeThread({ session: { status: "ready" } });
    const nextB = makeThread({
      environmentId: ENVIRONMENT_B,
      session: { status: "error" },
    });
    expect(
      deriveDesktopNotificationIntents(
        threadMap([previousA, previousB]),
        threadMap([nextA, nextB]),
      ).map((intent) => [intent.environmentId, intent.kind]),
    ).toEqual([
      [ENVIRONMENT_A, "completed"],
      [ENVIRONMENT_B, "failed"],
    ]);
  });

  it("emits independent notifications for separate threads", () => {
    const previousA = makeThread({ session: { status: "running" } });
    const previousB = makeThread({ id: THREAD_B });
    const nextA = makeThread({ session: { status: "ready" } });
    const nextB = makeThread({ id: THREAD_B, hasPendingUserInput: true });
    expect(
      deriveDesktopNotificationIntents(
        threadMap([previousA, previousB]),
        threadMap([nextA, nextB]),
      ).map((intent) => intent.kind),
    ).toEqual(["completed", "input"]);
  });
});

describe("observeDesktopNotificationThreads", () => {
  it("advances its baseline while disabled without replaying on enable", () => {
    const running = threadMap([makeThread({ session: { status: "running" } })]);
    const completed = threadMap([
      makeThread({
        session: { status: "ready" },
        latestTurn: { state: "completed" },
      }),
    ]);

    const disabledObservation = observeDesktopNotificationThreads(running, completed, false);
    expect(disabledObservation.intents).toEqual([]);

    const enabledObservation = observeDesktopNotificationThreads(
      disabledObservation.baseline,
      completed,
      true,
    );
    expect(enabledObservation.intents).toEqual([]);
  });

  it("uses the first observation as a silent bootstrap baseline", () => {
    const completed = threadMap([
      makeThread({
        session: { status: "ready" },
        latestTurn: { state: "completed" },
      }),
    ]);

    expect(observeDesktopNotificationThreads(null, completed, true)).toEqual({
      baseline: completed,
      intents: [],
    });
  });
});

describe("planDesktopNotificationDeliveries", () => {
  const intent: DesktopNotificationIntent = {
    environmentId: ENVIRONMENT_A,
    threadId: THREAD_A,
    threadTitle: "Fix release workflow",
    kind: "completed",
  };

  it("keeps a small batch as individual notifications", () => {
    expect(planDesktopNotificationDeliveries([intent, intent, intent])).toEqual([
      { type: "thread", intent },
      { type: "thread", intent },
      { type: "thread", intent },
    ]);
  });

  it("replaces overflow with one aggregate notification", () => {
    expect(planDesktopNotificationDeliveries([intent, intent, intent, intent])).toEqual([
      { type: "summary", count: 4 },
    ]);
  });
});

describe("desktopNotificationContent", () => {
  it.each([
    ["completed", "Task finished", "Fix release workflow is ready to review."],
    ["failed", "Task failed", "Fix release workflow needs attention."],
    ["approval", "Approval needed", "Fix release workflow is waiting for approval."],
    ["input", "Your input is needed", "Fix release workflow is waiting for your answer."],
  ] as const)("formats %s notifications", (kind, title, body) => {
    expect(
      desktopNotificationContent({
        environmentId: ENVIRONMENT_A,
        threadId: THREAD_A,
        threadTitle: "Fix release workflow",
        kind,
      }),
    ).toEqual({ title, body });
  });

  it("formats an aggregate notification for capped bursts", () => {
    expect(desktopNotificationSummaryContent(4)).toEqual({
      title: "Several tasks need attention",
      body: "4 tasks finished or are waiting for you.",
    });
  });
});

describe("showDesktopNotification", () => {
  it("creates a silent notification and focuses the task when clicked", () => {
    const instances: FakeNotification[] = [];
    const focus = vi.fn();
    const onClick = vi.fn();

    class FakeNotification extends EventTarget {
      static permission: NotificationPermission = "granted";
      readonly close = vi.fn();

      constructor(
        readonly title: string,
        readonly options: NotificationOptions,
      ) {
        super();
        instances.push(this);
      }
    }

    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("window", { focus });

    expect(
      showDesktopNotification(
        {
          environmentId: ENVIRONMENT_A,
          threadId: THREAD_A,
          threadTitle: "Fix release workflow",
          kind: "completed",
        },
        onClick,
      ),
    ).toBe(true);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.title).toBe("Task finished");
    expect(instances[0]?.options).toMatchObject({
      body: "Fix release workflow is ready to review.",
      silent: true,
      tag: expect.any(String),
    });

    instances[0]?.dispatchEvent(new Event("click"));
    expect(instances[0]?.close).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not create notifications without permission", () => {
    class DeniedNotification extends EventTarget {
      static permission: NotificationPermission = "denied";
    }
    vi.stubGlobal("Notification", DeniedNotification);

    expect(getDesktopNotificationPermission()).toBe("denied");
    expect(
      showDesktopNotification(
        {
          environmentId: ENVIRONMENT_A,
          threadId: THREAD_A,
          threadTitle: "Fix release workflow",
          kind: "completed",
        },
        vi.fn(),
      ),
    ).toBe(false);
  });
});
