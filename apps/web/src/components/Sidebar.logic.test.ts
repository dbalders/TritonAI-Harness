import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { deriveActiveWorkStartedAt } from "../session-logic.ts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  archiveSelectedThreadEntries,
  deleteSelectedThreadEntries,
  getFallbackThreadIdAfterDelete,
  hasUnseenCompletion,
  resolveSidebarRowThreadId,
  isSidebarThreadWorking,
  orderItemsByPreferredIds,
  pinOrderKeyBetween,
  resolveProjectStatusIndicator,
  resolveSidebarSweepKeys,
  resolveSidebarThreadStatus,
  resolveSidebarV2TopStatus,
  resolveThreadStatusPill,
  resolveWorkingStartedAt,
  searchSidebarThreads,
  shouldRecedeSidebarThread,
  sortInboxThreadsByReturn,
  resolveSidebarDropTarget,
  planSidebarThreadDrop,
  sortPinnedThreadsForSidebar,
  sortProjectsForSidebar,
  sortScopedProjectsForSidebar,
  sortSidebarV2ProjectGroups,
  shouldNavigateAfterThreadPark,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
  resolveSidebarDropVerb,
} from "./Sidebar.logic";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type Project,
  type Thread,
} from "../types";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../test-fixtures";
import {
  completeSidebarRouteReveal,
  pendingSidebarRouteReveal,
  resolveSidebarRouteReveal,
} from "./sidebar/routeReveal";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";
import {
  groupThreadsByProjectForSidebar,
  applySidebarThreadDrop,
  moveSidebarThreadWithinFolder,
  sidebarMarkerId,
  sidebarListItemId,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import { type SidebarThreadSummary } from "../types";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("deleteSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = AsyncResult.success(undefined);
  const failure = AsyncResult.failure(Cause.fail(new Error("Delete failed")));
  const interrupted = AsyncResult.failure(Cause.interrupt());

  it("waits for each delete and excludes only earlier successes from worktree checks", async () => {
    let resolveDelete!: (result: typeof success) => void;
    const pendingDelete = new Promise<typeof success>((resolve) => {
      resolveDelete = resolve;
    });
    const worktreeChecks: { threadKey: string; deletedThreadKeys: string[] }[] = [];
    const deletion = deleteSelectedThreadEntries({
      entries,
      delete: async ({ threadKey }, deletedThreadKeys) => {
        worktreeChecks.push({ threadKey, deletedThreadKeys: [...deletedThreadKeys] });
        return threadKey === "one" ? pendingDelete : success;
      },
    });

    expect(worktreeChecks).toEqual([{ threadKey: "one", deletedThreadKeys: [] }]);
    resolveDelete(success);
    const outcome = await deletion;

    expect(worktreeChecks).toEqual([
      { threadKey: "one", deletedThreadKeys: [] },
      { threadKey: "two", deletedThreadKeys: ["one"] },
      { threadKey: "three", deletedThreadKeys: ["one", "two"] },
    ]);
    expect(outcome).toEqual({
      deletedThreadKeys: new Set(["one", "two", "three"]),
      firstFailure: null,
    });
  });

  it("continues after ordinary failures and keeps the first failure", async () => {
    const laterFailure = AsyncResult.failure(Cause.fail(new Error("Later failure")));
    const deletedKeysAtLastEntry: string[][] = [];
    const outcome = await deleteSelectedThreadEntries({
      entries: [...entries, { threadKey: "four" }],
      delete: async ({ threadKey }, deletedThreadKeys) => {
        if (threadKey === "one") return failure;
        if (threadKey === "three") return laterFailure;
        if (threadKey === "four") deletedKeysAtLastEntry.push([...deletedThreadKeys]);
        return success;
      },
    });

    expect(deletedKeysAtLastEntry).toEqual([["two"]]);
    expect(outcome).toEqual({
      deletedThreadKeys: new Set(["two", "four"]),
      firstFailure: failure,
    });
  });

  it.each([
    { firstResult: success, deletedThreadKeys: new Set(["one"]), firstFailure: null },
    { firstResult: failure, deletedThreadKeys: new Set<string>(), firstFailure: failure },
  ])("stops on interruption and preserves earlier results %#", async (testCase) => {
    const attemptedThreadKeys: string[] = [];
    const outcome = await deleteSelectedThreadEntries({
      entries,
      delete: async ({ threadKey }) => {
        attemptedThreadKeys.push(threadKey);
        return threadKey === "one" ? testCase.firstResult : interrupted;
      },
    });

    expect(attemptedThreadKeys).toEqual(["one", "two"]);
    expect(outcome).toEqual({
      deletedThreadKeys: testCase.deletedThreadKeys,
      firstFailure: testCase.firstFailure,
    });
  });
});

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });
});

describe("sidebar thread lineage helpers", () => {
  it("maps an open subagent to its nearest visible ancestor's sidebar row", () => {
    const environmentId = EnvironmentId.make("environment-row");
    const otherEnvironmentId = EnvironmentId.make("environment-other");
    const subagentOf = (id: string, parentId: ThreadId, environment = environmentId) =>
      makeThreadFixture({
        id: ThreadId.make(id),
        environmentId: environment,
        lineage: {
          rootThreadId: parentId,
          parentThreadId: parentId,
          relationshipToParent: "subagent",
        },
      });
    const root = makeThreadFixture({ id: ThreadId.make("thread-root"), environmentId });
    const fork = makeThreadFixture({
      id: ThreadId.make("thread-fork"),
      environmentId,
      lineage: {
        rootThreadId: root.id,
        parentThreadId: root.id,
        relationshipToParent: "fork",
      },
    });
    const child = subagentOf("thread-child", root.id);
    const grandchild = subagentOf("thread-grandchild", child.id);
    const forkChild = subagentOf("thread-fork-child", fork.id);
    const orphan = subagentOf("thread-orphan", ThreadId.make("thread-missing"));
    const elsewhere = subagentOf("thread-elsewhere", root.id, otherEnvironmentId);
    const threads = [root, fork, child, grandchild, forkChild, orphan, elsewhere];

    expect(resolveSidebarRowThreadId(child.id, environmentId, threads)).toBe(root.id);
    expect(resolveSidebarRowThreadId(grandchild.id, environmentId, threads)).toBe(root.id);
    expect(resolveSidebarRowThreadId(forkChild.id, environmentId, threads)).toBe(fork.id);
    expect(resolveSidebarRowThreadId(elsewhere.id, otherEnvironmentId, threads)).toBe(elsewhere.id);
    expect(resolveSidebarRowThreadId(orphan.id, environmentId, threads)).toBe(orphan.id);
    const loopA = subagentOf("thread-loop-a", ThreadId.make("thread-loop-b"));
    const loopB = subagentOf("thread-loop-b", loopA.id);
    expect(resolveSidebarRowThreadId(loopA.id, environmentId, [loopA, loopB])).toBe(loopA.id);
  });
});

function makeLatestRun(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): NonNullable<Thread["latestRun"]> {
  return {
    runId: "turn-1" as never,
    status: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt:
      overrides?.startedAt !== undefined ? overrides.startedAt : "2026-03-09T10:00:00.000Z",
    completedAt:
      overrides?.completedAt !== undefined ? overrides.completedAt : "2026-03-09T10:05:00.000Z",
  };
}

describe("orderItemsByPreferredIds", () => {
  it("resolves legacy preference aliases without materializing project state", () => {
    const ordered = orderItemsByPreferredIds({
      items: [
        { id: "physical-a", cwd: "/work/a" },
        { id: "physical-b", cwd: "/work/b" },
        { id: "physical-c", cwd: "/work/c" },
      ],
      preferredIds: ["legacy:/work/c", "legacy:/work/a"],
      getId: (project) => project.id,
      getPreferenceIds: (project) => [project.id, `legacy:${project.cwd}`],
    });

    expect(ordered.map((project) => project.id)).toEqual([
      "physical-c",
      "physical-a",
      "physical-b",
    ]);
  });
});

describe("resolveSidebarThreadStatus", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };

  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, runtime: null };

  it("prioritizes awaiting input over a running runtime, below approval", () => {
    expect(resolveSidebarThreadStatus({ ...idle, hasPendingUserInput: true, runtime })).toBe(
      "input",
    );
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        runtime,
      }),
    ).toBe("approval");
  });

  it("shows a waiting guest message as a Request, below the agent's own requests", () => {
    expect(resolveSidebarThreadStatus({ ...idle, pendingGuestMessageCount: 1, runtime })).toBe(
      "request",
    );
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        hasPendingUserInput: true,
        pendingGuestMessageCount: 1,
      }),
    ).toBe("input");
  });

  it("keeps usage-limit stops Limited and visible until the thread recovers", () => {
    const limited = {
      ...runtime,
      status: "failed" as const,
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit" as const,
    };
    expect(resolveSidebarThreadStatus({ ...idle, runtime: limited })).toBe("limited");
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime: { ...limited, status: "running" } }),
    ).toBe("working");
    expect(
      resolveSidebarThreadStatus({ ...idle, runtime: { ...limited, status: "completed" } }),
    ).toBe("ready");
    expect(resolveSidebarV2TopStatus({ status: "limited", isUnread: false, isWoke: false })).toBe(
      "limited",
    );
    expect(
      shouldRecedeSidebarThread({
        status: "limited",
        isUnread: false,
        isWoke: false,
        isActive: false,
        isSelected: false,
      }),
    ).toBe(false);
  });

  it("reports failed only while the latest run failed", () => {
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe("failed");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "completed" as const, lastError: "persisted" },
      }),
    ).toBe("ready");
    expect(
      resolveSidebarThreadStatus({
        ...idle,
        runtime: { ...runtime, status: "idle" as const, lastError: "persisted" },
      }),
    ).toBe("waiting");
  });
});

describe("searchSidebarThreads", () => {
  const searchThread = (id: string, title: string, latestUserMessageAt: string) => ({
    environmentId: localEnvironmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: latestUserMessageAt,
    latestUserMessageAt,
    opens: null,
  });
  const threads = [
    searchThread("thread-1", "Fix workspace search", "2026-10-20T00:00:00.000Z"),
    searchThread("thread-2", "Review providers", "2026-10-22T00:00:00.000Z"),
    searchThread("thread-3", "WORKTREE cleanup", "2026-09-01T00:00:00.000Z"),
    searchThread("thread-4", "Homework notes", "2026-10-22T00:00:00.000Z"),
  ];
  const now = Date.parse("2026-10-23T00:00:00.000Z");
  const contentKeys = (...ids: ReadonlyArray<string>) =>
    new Set(
      ids.map((id) =>
        threadSearchMatchKey({ environmentId: localEnvironmentId, threadId: ThreadId.make(id) }),
      ),
    );

  it("ranks word matches by recent use, then lists message matches once", () => {
    expect(searchSidebarThreads(threads, "work", contentKeys("thread-1", "thread-2"), now)).toEqual(
      {
        titleMatches: [threads[0], threads[2], threads[3]],
        contentMatches: [threads[1]],
      },
    );
  });
});

describe("resolveWorkingStartedAt", () => {
  const runtime = {
    status: "running" as const,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    activeRunId: RunId.make("turn-1"),
    lastError: null,
    updatedAt: "2026-03-09T10:02:00.000Z",
  };

  it("does not invent a start from activity updates when the newest run completed", () => {
    expect(
      resolveWorkingStartedAt({
        latestRun: makeLatestRun(),
        runtime,
      }),
    ).toBeNull();
  });

  it.each(["queued", "cancelled"] as const)(
    "shares the detail timer when a newer run is %s",
    (status) => {
      const activityStartedAt = "2026-03-09T10:00:00.000Z";
      const latestRun = {
        ...makeLatestRun(),
        runId: RunId.make("newer-run"),
        status,
        startedAt: null,
        completedAt: status === "queued" ? null : "2026-03-09T10:05:00.000Z",
      };
      for (const updatedAt of ["2026-03-09T10:30:00.000Z", "2026-03-09T10:50:00.000Z"]) {
        const activeRuntime = { ...runtime, updatedAt, activityStartedAt };
        expect(resolveWorkingStartedAt({ latestRun, runtime: activeRuntime })).toBe(
          activityStartedAt,
        );
        expect(deriveActiveWorkStartedAt(latestRun, activeRuntime, updatedAt)).toBe(
          activityStartedAt,
        );
      }
      expect(
        deriveActiveWorkStartedAt(
          latestRun,
          { ...runtime, activityStartedAt: null },
          "2026-03-09T10:50:00.000Z",
        ),
      ).toBeNull();
    },
  );
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestRun: null,
    lastVisitedAt: undefined,
    runtime: {
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      activeRunId: "turn-1" as never,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };

  it("shows an active thread wait without a pulse and resumes Working when it ends", () => {
    const blocked = { ...baseThread, blockedOnThreadWait: true };
    expect(resolveSidebarThreadStatus(blocked)).toBe("waiting");
    expect(resolveThreadStatusPill({ thread: blocked })).toMatchObject({
      label: "Waiting",
      pulse: false,
    });

    const resumed = { ...blocked, blockedOnThreadWait: false };
    expect(resolveSidebarThreadStatus(resumed)).toBe("working");
    expect(resolveThreadStatusPill({ thread: resumed })).toMatchObject({
      label: "Working",
      pulse: true,
    });
  });

  it("shows waiting for an idle thread with pending background tasks", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          pendingBackgroundTasks: [
            { taskId: "bg-1", description: "Watch build", kind: "monitor", awaited: true },
          ],
          runtime: {
            ...baseThread.runtime,
            status: "idle",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({
      label: "Waiting",
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestRun: makeLatestRun(),
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("does not manufacture completed state without a client visit marker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestRun: makeLatestRun(),
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toBeNull();
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestRun: makeLatestRun(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: {
            ...baseThread.runtime,
            status: "completed",
            activeRunId: null,
          },
        },
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });

  it("shows failed, not completed, when the unseen run failed", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestRun: { ...makeLatestRun(), status: "failed" },
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: {
            ...baseThread.runtime,
            status: "failed",
            activeRunId: null,
            lastError: "Provider turn failed.",
          },
        },
      }),
    ).toMatchObject({ label: "Failed", pulse: false });
  });

  it("shows failed, not plan ready, when a plan run proposed a plan and then failed", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          hasActionableProposedPlan: true,
          latestRun: { ...makeLatestRun(), status: "failed" },
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          runtime: { ...baseThread.runtime, status: "failed", activeRunId: null },
        },
      }),
    ).toMatchObject({ label: "Failed" });
  });

  it("drops the failed pill once the failure has been seen", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestRun: { ...makeLatestRun(), status: "failed" },
          lastVisitedAt: "2026-03-09T10:06:00.000Z",
          runtime: { ...baseThread.runtime, status: "failed", activeRunId: null },
        },
      }),
    ).toBeNull();
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("ranks waiting below active work and above plan-ready", () => {
    const waiting = {
      label: "Waiting" as const,
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };

    expect(
      resolveProjectStatusIndicator([
        waiting,
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Working" });
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
        waiting,
      ]),
    ).toMatchObject({ label: "Waiting" });
  });
});

function makeProject(overrides: Partial<Project> = {}): Project {
  const { defaultModelSelection, ...rest } = overrides;
  return {
    id: ProjectId.make("project-1"),
    environmentId: localEnvironmentId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...defaultModelSelection,
    },
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    scripts: [],
    ...rest,
  };
}

function makeThread(overrides: ThreadFixtureOverrides = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      ...overrides?.modelSelection,
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("getFallbackThreadIdAfterDelete", () => {
  it("skips other threads being deleted in the same action", () => {
    const fallbackThreadId = getFallbackThreadIdAfterDelete({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:05:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-newest"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:10:00.000Z",
          messages: [],
        }),
        makeThread({
          id: ThreadId.make("thread-next"),
          projectId: ProjectId.make("project-1"),
          createdAt: "2026-03-09T10:07:00.000Z",
          messages: [],
        }),
      ],
      deletedThreadId: ThreadId.make("thread-active"),
      deletedThreadIds: new Set([ThreadId.make("thread-active"), ThreadId.make("thread-newest")]),
      sortOrder: "created_at",
    });

    expect(fallbackThreadId).toBe(ThreadId.make("thread-next"));
  });
});
describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      makeProject({ id: ProjectId.make("project-1"), title: "Older project" }),
      makeProject({ id: ProjectId.make("project-2"), title: "Newer project" }),
    ];
    const threads = [
      makeThread({
        projectId: ProjectId.make("project-1"),
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [
          {
            id: "message-1" as never,
            role: "user",
            text: "older project user message",
            runId: null,
            createdAt: "2026-03-09T10:01:00.000Z",
            updatedAt: "2026-03-09T10:01:00.000Z",
            streaming: false,
          },
        ],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-2"),
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [
          {
            id: "message-2" as never,
            role: "user",
            text: "newer project user message",
            runId: null,
            createdAt: "2026-03-09T10:05:00.000Z",
            updatedAt: "2026-03-09T10:05:00.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });
});

describe("sortScopedProjectsForSidebar", () => {
  it("keeps identical project ids in different environments separate", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const sharedProjectId = ProjectId.make("shared-project");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: sharedProjectId,
        title: "Local project",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: sharedProjectId,
        title: "Remote project",
      }),
    ];
    const threads = [
      makeThread({
        environmentId: localEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        environmentId: remoteEnvironmentId,
        projectId: sharedProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual(["Remote project", "Local project"]);
  });

  it("does not use archived threads as project activity", () => {
    const projects = [
      makeProject({
        id: ProjectId.make("project-visible"),
        title: "Visible project",
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeProject({
        id: ProjectId.make("project-archived"),
        title: "Archived-only project",
        updatedAt: "2026-03-09T10:00:00.000Z",
      }),
    ];
    const threads = [
      makeThread({
        id: ThreadId.make("thread-visible"),
        projectId: ProjectId.make("project-visible"),
        updatedAt: "2026-03-09T10:02:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-archived"),
        projectId: ProjectId.make("project-archived"),
        updatedAt: "2026-03-09T10:10:00.000Z",
        archivedAt: "2026-03-09T10:11:00.000Z",
      }),
    ];

    const sorted = sortScopedProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.title)).toEqual([
      "Visible project",
      "Archived-only project",
    ]);
  });
});

describe("sortSidebarV2ProjectGroups", () => {
  it("does not let a hidden subagent thread reorder projects", () => {
    const olderProjectId = ProjectId.make("project-older");
    const newerProjectId = ProjectId.make("project-newer");
    const olderRootThreadId = ThreadId.make("thread-older-root");
    const projects = [
      {
        ...makeProject({ id: olderProjectId, title: "A older project" }),
        projectKey: "logical-older",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: olderProjectId }],
      },
      {
        ...makeProject({ id: newerProjectId, title: "Z newer project" }),
        projectKey: "logical-newer",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: newerProjectId }],
      },
    ];
    const threads = [
      makeThread({
        id: olderRootThreadId,
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:01:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-newer-root"),
        projectId: newerProjectId,
        updatedAt: "2026-03-09T10:05:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("thread-hidden-subagent"),
        projectId: olderProjectId,
        updatedAt: "2026-03-09T10:10:00.000Z",
        lineage: {
          rootThreadId: olderRootThreadId,
          parentThreadId: olderRootThreadId,
          relationshipToParent: "subagent",
        },
      }),
    ];

    expect(
      sortSidebarV2ProjectGroups(projects, threads, "updated_at").map(
        (project) => project.projectKey,
      ),
    ).toEqual(["logical-newer", "logical-older"]);
  });
});

describe("pinOrderKeyBetween", () => {
  it("stays strictly ordered under repeated top insertion", () => {
    let head: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(null, head)!;
      expect(key).not.toBeNull();
      if (head !== null) expect(key < head).toBe(true);
      keys.push(key);
      head = key;
    }
    expect(new Set(keys).size).toBe(100);
  });

  it("stays strictly ordered under repeated middle insertion", () => {
    let low = pinOrderKeyBetween(null, null)!;
    let high = pinOrderKeyBetween(low, null)!;
    for (let i = 0; i < 100; i += 1) {
      const key: string = pinOrderKeyBetween(low, high)!;
      expect(low < key && key < high).toBe(true);
      if (i % 2 === 0) low = key;
      else high = key;
    }
  });

  it("returns null for corrupt or out-of-order bounds instead of throwing", () => {
    expect(pinOrderKeyBetween("z", "a")).toBeNull();
    expect(pinOrderKeyBetween("A!", null)).toBeNull();
    expect(pinOrderKeyBetween(null, "ma")).toBeNull();
    expect(pinOrderKeyBetween("m", "m")).toBeNull();
  });
});

describe("sortPinnedThreadsForSidebar", () => {
  const pinnable = (input: { id: string; createdAt: string; pinOrderKey?: string | null }) => ({
    id: input.id,
    createdAt: input.createdAt,
    pinOrderKey: input.pinOrderKey ?? null,
  });

  it("sorts keyed threads by key ahead of keyless threads in creation order", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "keyless-old", createdAt: "2026-03-09T08:00:00.000Z" }),
      pinnable({ id: "second", createdAt: "2026-03-09T09:00:00.000Z", pinOrderKey: "t" }),
      pinnable({ id: "keyless-new", createdAt: "2026-03-09T12:00:00.000Z" }),
      pinnable({ id: "first", createdAt: "2026-03-09T07:00:00.000Z", pinOrderKey: "g" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual([
      "first",
      "second",
      "keyless-new",
      "keyless-old",
    ]);
  });

  it("breaks equal keys by id so raced writes render identically everywhere", () => {
    const sorted = sortPinnedThreadsForSidebar([
      pinnable({ id: "b", createdAt: "2026-03-09T10:00:00.000Z", pinOrderKey: "m" }),
      pinnable({ id: "a", createdAt: "2026-03-09T11:00:00.000Z", pinOrderKey: "m" }),
    ]);

    expect(sorted.map((thread) => thread.id)).toEqual(["a", "b"]);
  });
});

describe("resolveSidebarSweepKeys", () => {
  const ordered = ["a", "b", "c", "d", "blocked"];
  const canSettle = (key: string) => key !== "blocked";

  it("leaves out rows that cannot settle and rows that left the list", () => {
    expect(resolveSidebarSweepKeys(ordered, "c", "blocked", canSettle)).toEqual(["c", "d"]);
    expect(resolveSidebarSweepKeys(ordered, "gone", "a", canSettle)).toEqual([]);
  });
});

describe("navigation after parking a thread", () => {
  it.each([
    ["settle", "settled", null, "thread", true],
    ["settle", "active", null, "thread", false],
    ["settle", "settled", null, "other-thread", false],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "thread", true],
    ["snooze", null, null, "thread", false],
    ["snooze", null, "2026-09-12T09:00:00.000Z", "thread", false],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "thread", false, true],
    ["snooze", null, "2099-01-01T00:00:00.000Z", "other-thread", false],
  ] as const)(
    "%s with state %s / %s on %s navigates: %s",
    (
      action,
      settledOverride,
      snoozedUntil,
      currentThreadKey,
      expected,
      hasPendingApprovals: boolean = false,
    ) => {
      expect(
        shouldNavigateAfterThreadPark({
          threadKey: "thread",
          currentThreadKey,
          action,
          now: "2026-09-12T10:00:00.000Z",
          thread: {
            settledOverride,
            snoozedUntil,
            snoozedAt: null,
            runtime: null,
            latestRun: null,
            hasPendingApprovals,
            hasPendingUserInput: false,
          },
        }),
      ).toBe(expected);
    },
  );
});

describe("unseen completion with background work", () => {
  it.each([
    {
      roster: "dev server",
      task: { kind: "command" },
      status: "ready",
      topStatus: "done",
      receded: false,
      pill: "Completed",
    },
    {
      roster: "dev server watchdog",
      task: { kind: "monitor" },
      status: "ready",
      topStatus: "done",
      receded: false,
      pill: "Completed",
    },
    {
      roster: "awaited command",
      task: { kind: "command", awaited: true },
      status: "waiting",
      topStatus: "waiting",
      receded: true,
      pill: "Waiting",
    },
  ] as const)("presents a completed thread with a $roster roster", (expected) => {
    const thread = presentThreadShell(localEnvironmentId, {
      ...makeThreadFixture().source,
      latestRunId: RunId.make("run-background-completion"),
      status: "completed",
      latestRunCompletedAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
      lastVisitedAt: DateTime.makeUnsafe("2026-06-20T00:59:00.000Z"),
      pendingBackgroundTasks: [{ taskId: "background-work", ...expected.task }],
    });
    const status = resolveSidebarThreadStatus(thread);
    const isUnread = hasUnseenCompletion(thread);

    expect(isUnread).toBe(true);
    expect(status).toBe(expected.status);
    expect(resolveSidebarV2TopStatus({ status, isUnread, isWoke: false })).toBe(expected.topStatus);
    expect(
      shouldRecedeSidebarThread({
        status,
        isUnread,
        isWoke: false,
        isActive: false,
        isSelected: false,
      }),
    ).toBe(expected.receded);
    expect(isSidebarThreadWorking(thread)).toBe(expected.receded);
    expect(resolveThreadStatusPill({ thread })).toMatchObject({ label: expected.pill });
  });
});

describe("Working shelf (beta)", () => {
  const runtime = {
    status: "running" as const,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-03-09T10:00:00.000Z",
  };
  const backgroundTask = {
    taskId: "bg-1",
    description: "Watch build",
    kind: "monitor" as const,
    awaited: true as const,
  };
  const idle = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestRun: makeLatestRun(),
    runtime: null,
  };
  const waiting = {
    ...idle,
    runtime: { ...runtime, status: "idle" as const },
    pendingBackgroundTasks: [backgroundTask],
  };

  it("folds away running threads and threads waiting on background work only", () => {
    expect(isSidebarThreadWorking({ ...idle, runtime })).toBe(true);
    expect(isSidebarThreadWorking(waiting)).toBe(true);
    expect(isSidebarThreadWorking(idle)).toBe(false);
    expect(isSidebarThreadWorking({ ...idle, runtime, hasPendingApprovals: true })).toBe(false);
    expect(isSidebarThreadWorking({ ...idle, runtime, hasPendingUserInput: true })).toBe(false);
    expect(
      isSidebarThreadWorking({
        ...waiting,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe(false);
  });

  it("keeps a ready plan in the inbox while background work runs", () => {
    expect(
      isSidebarThreadWorking({
        ...waiting,
        interactionMode: "plan",
        hasActionableProposedPlan: true,
      }),
    ).toBe(false);
  });

  describe("sortInboxThreadsByReturn", () => {
    const thread = (
      id: string,
      input: { createdAt: string; completedAt?: string | null; unsettledAt?: string },
    ) => ({
      id: ThreadId.make(id),
      environmentId: localEnvironmentId,
      createdAt: input.createdAt,
      unsettledAt: input.unsettledAt ?? null,
      latestRun:
        input.completedAt === undefined
          ? null
          : { ...makeLatestRun({ completedAt: input.completedAt }), requestedAt: input.createdAt },
    });

    it("puts the thread that finished last on top, whatever its age", () => {
      const sorted = sortInboxThreadsByReturn([
        thread("new", { createdAt: "2026-03-09T11:00:00.000Z" }),
        thread("old-finished-now", {
          createdAt: "2026-03-01T09:00:00.000Z",
          completedAt: "2026-03-09T12:00:00.000Z",
        }),
        thread("reopened", {
          createdAt: "2026-03-02T09:00:00.000Z",
          unsettledAt: "2026-03-09T11:30:00.000Z",
        }),
      ]);
      expect(sorted.map((entry) => entry.id)).toEqual(["old-finished-now", "reopened", "new"]);
    });

    it("counts a return the server does not stamp, like an approval request", () => {
      const waiting = thread("asks-approval", {
        createdAt: "2026-03-09T09:00:00.000Z",
        completedAt: null,
      });
      const finished = thread("finished", {
        createdAt: "2026-03-09T09:30:00.000Z",
        completedAt: "2026-03-09T11:00:00.000Z",
      });
      expect(sortInboxThreadsByReturn([finished, waiting]).map((entry) => entry.id)).toEqual([
        "finished",
        "asks-approval",
      ]);
      expect(
        sortInboxThreadsByReturn([finished, waiting], (entry) =>
          entry === waiting ? Date.parse("2026-03-09T11:05:00.000Z") : undefined,
        ).map((entry) => entry.id),
      ).toEqual(["asks-approval", "finished"]);
    });
  });

  describe("dragging", () => {
    const marker = (name: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker: name });
    const row = (key: string, section: SidebarSection): SidebarListItem => ({
      kind: "thread",
      key,
      section,
    });
    const items: readonly SidebarListItem[] = [
      marker("pinned-header"),
      row("p1", "pinned"),
      marker("pinned-divider"),
      row("a1", "active"),
      row("a2", "active"),
      marker("working-header"),
      row("w1", "working"),
      marker("settled-header"),
      row("s1", "settled"),
    ];

    it("never drops into the Working shelf, and keeps it out of the inbox order", () => {
      expect(resolveSidebarDropTarget(items, "a1", "w1")).toBeNull();
      expect(resolveSidebarDropTarget(items, "p1", "a2")).toEqual({
        section: "active",
        pinnedOrder: [],
        activeOrder: ["a1", "a2", "p1"],
      });
      expect(resolveSidebarDropVerb("active", "working")).toBeNull();
    });

    it.each([
      ["pinned", "p1"],
      ["active", "a2"],
      ["settled", "s1"],
    ] as const)(
      "does not move a Working thread into %s when its reference drag ends in the sidebar",
      (section, overKey) => {
        const target = resolveSidebarDropTarget(items, "w1", overKey);
        expect(target?.section).toBe(section);
        expect(
          planSidebarThreadDrop({
            activeKey: "w1",
            activeSection: "working",
            target: target!,
            pinnedOrder: ["p1"],
            pinnedKeysById: new Map([["p1", "m"]]),
            activeOrder: ["a1", "a2"],
            activeKeysById: new Map([
              ["a1", "f"],
              ["a2", "t"],
            ]),
            activeTimeOrdered: true,
          }),
        ).toEqual({ kind: "none" });
      },
    );

    it("arranges the rows it can write when another row's server cannot store an order", () => {
      const plan = planSidebarThreadDrop({
        activeKey: "a2",
        activeSection: "active",
        target: {
          section: "active",
          pinnedOrder: [],
          activeOrder: ["offline", "a2", "a1"],
        },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["offline", "a1", "a2"],
        activeKeysById: new Map([
          ["offline", null],
          ["a1", null],
          ["a2", null],
        ]),
        activeReorderableKeys: new Set(["a1", "a2"]),
      });
      expect(plan.kind).toBe("move-active");
      if (plan.kind !== "move-active") return;
      expect(plan.assignments.map(({ id }) => id)).toEqual(["a2", "a1"]);
      const [a2, a1] = plan.assignments.map(({ orderKey }) => orderKey);
      expect(a2! < a1!).toBe(true);

      const above = planSidebarThreadDrop({
        activeKey: "a2",
        activeSection: "active",
        target: { section: "active", pinnedOrder: [], activeOrder: ["a2", "offline"] },
        pinnedOrder: [],
        pinnedKeysById: new Map(),
        activeOrder: ["offline", "a2"],
        activeKeysById: new Map([
          ["offline", "m"],
          ["a2", "t"],
        ]),
        activeReorderableKeys: new Set(["a2"]),
      });
      expect(above.kind === "move-active" && above.assignments[0]!.orderKey < "m").toBe(true);
    });

    it("only changes lifecycle when the inbox is time-ordered", () => {
      const base = {
        pinnedOrder: ["p1"],
        pinnedKeysById: new Map([["p1", "m"]]),
        activeOrder: ["a1", "a2"],
        activeKeysById: new Map([
          ["a1", "f"],
          ["a2", "t"],
        ]),
        activeTimeOrdered: true,
      };
      expect(
        planSidebarThreadDrop({
          ...base,
          activeKey: "a1",
          activeSection: "active",
          target: { section: "active", pinnedOrder: ["p1"], activeOrder: ["a2", "a1"] },
        }),
      ).toEqual({ kind: "none" });
      expect(
        planSidebarThreadDrop({
          ...base,
          activeKey: "p1",
          activeSection: "pinned",
          target: { section: "active", pinnedOrder: [], activeOrder: ["a1", "p1", "a2"] },
        }),
      ).toEqual({
        kind: "move-active",
        order: null,
        assignments: [],
        unpin: true,
        unsettle: false,
        unsnooze: false,
      });
    });
  });
  it("folds away running and monitoring threads only", () => {
    expect(isSidebarThreadWorking({ ...idle, runtime })).toBe(true);
    expect(isSidebarThreadWorking(waiting)).toBe(true);
    expect(isSidebarThreadWorking(idle)).toBe(false);
    expect(isSidebarThreadWorking({ ...idle, runtime, hasPendingApprovals: true })).toBe(false);
    expect(isSidebarThreadWorking({ ...idle, runtime, hasPendingUserInput: true })).toBe(false);
    expect(
      isSidebarThreadWorking({
        ...idle,
        runtime: { ...runtime, status: "failed" as const, lastError: "boom" },
      }),
    ).toBe(false);
  });
});

describe("pendingSidebarRouteReveal", () => {
  it("keeps a revealed thread settled across a mount that reads no route params", () => {
    const reveal = { observedKey: null, pendingKey: null };
    expect(pendingSidebarRouteReveal(reveal, "env:a1")).toBe("env:a1");
    completeSidebarRouteReveal(reveal);

    // Back from Settings: location commits before the thread match does.
    expect(pendingSidebarRouteReveal(reveal, null)).toBeNull();
    expect(pendingSidebarRouteReveal(reveal, "env:a1")).toBeNull();

    expect(pendingSidebarRouteReveal(reveal, "env:b1")).toBe("env:b1");
  });

  it("keeps a pending reveal through a render without route params", () => {
    const reveal = { observedKey: null, pendingKey: null };
    pendingSidebarRouteReveal(reveal, "env:a1");
    expect(pendingSidebarRouteReveal(reveal, null)).toBeNull();
    expect(pendingSidebarRouteReveal(reveal, "env:a1")).toBe("env:a1");
  });
});

describe("resolveSidebarRouteReveal", () => {
  const scopedProjectKeys = new Set(["environment-test:project-scoped"]);
  const hidden = makeThreadFixture({ projectId: ProjectId.make("project-other") });
  const hiddenKey = "environment-test:thread-test";
  const findThread = (key: string) => (key === hiddenKey ? hidden : undefined);

  it("widens the scope for a newly opened thread the scope hides", () => {
    expect(
      resolveSidebarRouteReveal({
        reveal: { observedKey: "environment-test:other", pendingKey: null },
        routeKey: hiddenKey,
        isSearching: false,
        scopedProjectKeys,
        findThread,
      }),
    ).toEqual({ pendingKey: hiddenKey, widensScope: true });
  });

  it("never widens for a thread whose reveal already completed", () => {
    // A remount's once-per-mount scroll must keep the scope the user chose.
    expect(
      resolveSidebarRouteReveal({
        reveal: { observedKey: hiddenKey, pendingKey: null },
        routeKey: hiddenKey,
        isSearching: false,
        scopedProjectKeys,
        findThread,
      }),
    ).toEqual({ pendingKey: null, widensScope: false });
  });

  it("widens again for a thread reopened before the thread between them listed its row", () => {
    // The user scoped away from the open thread, then went to a thread whose row
    // never mounted, then came back.
    const reveal = { observedKey: hiddenKey, pendingKey: null };
    const resolve = (routeKey: string) =>
      resolveSidebarRouteReveal({
        reveal,
        routeKey,
        isSearching: false,
        scopedProjectKeys,
        findThread,
      });
    resolve("environment-test:unlisted");
    expect(resolve(hiddenKey)).toEqual({ pendingKey: hiddenKey, widensScope: true });
  });

  it("holds a pending reveal without widening while searching", () => {
    expect(
      resolveSidebarRouteReveal({
        reveal: { observedKey: hiddenKey, pendingKey: hiddenKey },
        routeKey: hiddenKey,
        isSearching: true,
        scopedProjectKeys,
        findThread,
      }),
    ).toEqual({ pendingKey: hiddenKey, widensScope: false });
  });
});
describe("groupThreadsByProjectForSidebar", () => {
  it("preserves project order and sorts each project by activity", () => {
    const alphaProjectId = ProjectId.make("project-alpha");
    const betaProjectId = ProjectId.make("project-beta");
    const projects = [
      {
        ...makeProject({ id: betaProjectId, title: "Beta" }),
        projectKey: "logical-beta",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: betaProjectId }],
      },
      {
        ...makeProject({ id: alphaProjectId, title: "Alpha" }),
        projectKey: "logical-alpha",
        memberProjectRefs: [{ environmentId: localEnvironmentId, projectId: alphaProjectId }],
      },
    ];
    const threads = [
      makeThread({
        id: ThreadId.make("alpha-older"),
        projectId: alphaProjectId,
        updatedAt: "2026-03-09T09:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("beta-only"),
        projectId: betaProjectId,
        updatedAt: "2026-03-09T10:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("alpha-newer"),
        projectId: alphaProjectId,
        updatedAt: "2026-03-09T11:00:00.000Z",
      }),
    ];

    const groups = groupThreadsByProjectForSidebar(projects, threads);

    expect(groups.map((group) => group.project?.projectKey ?? null)).toEqual([
      "logical-beta",
      "logical-alpha",
    ]);
    expect(groups[1]?.threads.map((thread) => thread.id)).toEqual(["alpha-newer", "alpha-older"]);

    // Folder grouping must not undo an explicit drag order within a project.
    const manuallyOrderedGroups = groupThreadsByProjectForSidebar(projects, threads, {
      preserveThreadOrder: true,
    });
    expect(manuallyOrderedGroups.map((group) => group.project?.projectKey)).toEqual([
      "logical-beta",
      "logical-alpha",
    ]);
    expect(manuallyOrderedGroups[1]?.threads.map((thread) => thread.id)).toEqual([
      "alpha-older",
      "alpha-newer",
    ]);
  });
});
describe("moveSidebarThreadWithinFolder", () => {
  const activeOrder = ["a1", "a2", "a3", "b1", "b2"];
  const folderKeys = ["a1", "a2", "a3"];
  it.each([
    ["a1", "a3", ["a2", "a3", "a1", "b1", "b2"]],
    ["a3", "a1", ["a3", "a1", "a2", "b1", "b2"]],
    ["a2", "a3", ["a1", "a3", "a2", "b1", "b2"]],
  ] as const)("moves %s onto %s inside its folder", (activeKey, overKey, expected) => {
    expect(moveSidebarThreadWithinFolder({ activeOrder, folderKeys, activeKey, overKey })).toEqual(
      expected,
    );
  });
});
describe("resolveSidebarDropTarget", () => {
  const thread = (key: string, section: SidebarSection): SidebarListItem => ({
    kind: "thread",
    key,
    section,
  });
  const marker = (marker: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker });
  const items: readonly SidebarListItem[] = [
    marker("pinned-header"),
    thread("p1", "pinned"),
    thread("p2", "pinned"),
    marker("pinned-divider"),
    thread("a1", "active"),
    thread("a2", "active"),
    marker("snoozed-header"),
    thread("z1", "snoozed"),
    marker("settled-header"),
    thread("s1", "settled"),
  ];
  const resolve = (activeKey: string, overId: string) =>
    resolveSidebarDropTarget(items, activeKey, overId);
  it("keeps marker-like scoped thread keys draggable", () => {
    const key = "marker:pinned-header";
    const list: SidebarListItem[] = [
      marker("pinned-header"),
      thread(key, "pinned"),
      thread("env:other", "pinned"),
      marker("pinned-divider"),
    ];
    expect(new Set(list.map(sidebarListItemId)).size).toBe(list.length);
    expect(resolveSidebarDropTarget(list, key, "env:other")).toEqual({
      section: "pinned",
      pinnedOrder: ["env:other", key],
      activeOrder: [],
    });
  });
  it("reads the section off the markers above the gap", () => {
    expect(resolve("p1", "a2")).toEqual({
      section: "active",
      pinnedOrder: ["p2"],
      activeOrder: ["a1", "a2", "p1"],
    });
    expect(resolve("a1", "s1")).toEqual({
      section: "settled",
      pinnedOrder: ["p1", "p2"],
      activeOrder: ["a2"],
    });
    expect(resolve("s1", "a1")).toEqual({
      section: "active",
      pinnedOrder: ["p1", "p2"],
      activeOrder: ["s1", "a1", "a2"],
    });
  });
  it("uses arrayMove placement, so a marker hovered from below lands above it", () => {
    // Dragging a1 up onto the divider: the divider shifts down, a1 becomes
    // the last pinned row.
    expect(resolve("a1", sidebarMarkerId("pinned-divider"))).toEqual({
      section: "pinned",
      pinnedOrder: ["p1", "p2", "a1"],
      activeOrder: ["a2"],
    });
    // Dragging p2 down onto the divider: the divider shifts up, p2 is the
    // first inbox row — an unpin.
    expect(resolve("p2", sidebarMarkerId("pinned-divider"))).toEqual({
      section: "active",
      pinnedOrder: ["p1"],
      activeOrder: ["p2", "a1", "a2"],
    });
    // Same on the Settled header: from above it settles; from below the
    // gap lands in whatever is above the header — here the snoozed shelf,
    // which is never a target.
    expect(resolve("a2", sidebarMarkerId("settled-header"))?.section).toBe("settled");
    expect(resolve("s1", sidebarMarkerId("settled-header"))).toBeNull();
  });
});
describe("planSidebarThreadDrop", () => {
  const pinnedKeysById = new Map<string, string | null>([
    ["p1", "f"],
    ["p2", "m"],
    ["p3", "t"],
  ]);
  const activeKeysById = new Map<string, string | null>([
    ["a1", "f"],
    ["a2", "m"],
    ["a3", "t"],
  ]);
  const plan = (
    overrides: Partial<Omit<Parameters<typeof planSidebarThreadDrop>[0], "target">> & {
      activeKey: string;
      activeSection: "pinned" | "active" | "snoozed" | "settled";
      target: Omit<Parameters<typeof planSidebarThreadDrop>[0]["target"], "activeOrder"> & {
        activeOrder?: readonly string[];
      };
    },
  ) =>
    planSidebarThreadDrop({
      pinnedOrder: ["p1", "p2", "p3"],
      pinnedKeysById,
      activeOrder: ["a1", "a2", "a3"],
      activeKeysById,
      ...overrides,
      target: { activeOrder: [], ...overrides.target },
    });
  it("allows old-server pinned reordering while rejecting settlement", () => {
    expect(
      plan({
        activeKey: "p1",
        activeSection: "pinned",
        supportsSettlement: false,
        target: { section: "pinned", pinnedOrder: ["p2", "p1", "p3"] },
      }).kind,
    ).toBe("reorder-pinned");
    expect(
      plan({
        activeKey: "p1",
        activeSection: "pinned",
        supportsSettlement: false,
        target: { section: "settled", pinnedOrder: ["p2", "p3"] },
      }),
    ).toEqual({ kind: "none" });
  });
  it.each(["pinned", "active"] as const)("reserves hidden %s slots during a drop", (section) => {
    const order = section === "pinned" ? ["p2", "p1", "p3"] : ["a2", "a1", "a3"];
    const keys = new Map(section === "pinned" ? pinnedKeysById : activeKeysById);
    const moved = section === "pinned" ? "p1" : "a1";
    const reserved = pinOrderKeyBetween(keys.get(order[0]!)!, keys.get(order[2]!)!)!;
    keys.set("snoozed", reserved);
    const result = plan({
      activeKey: moved,
      activeSection: section,
      pinnedKeysById: section === "pinned" ? keys : pinnedKeysById,
      activeKeysById: section === "active" ? keys : activeKeysById,
      target: {
        section,
        pinnedOrder: section === "pinned" ? order : [],
        activeOrder: section === "active" ? order : [],
      },
    });
    if (result.kind !== "reorder-pinned" && result.kind !== "move-active")
      throw new Error("Expected reorder");
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]!.orderKey).not.toBe(reserved);
  });
  it.each([
    { key: "p2", section: "pinned" as const, unpin: true, unsettle: false, unsnooze: false },
    { key: "s1", section: "settled" as const, unpin: false, unsettle: true, unsnooze: false },
    { key: "z1", section: "snoozed" as const, unpin: false, unsettle: false, unsnooze: true },
  ])("moves a $section thread to the chosen Active slot", (source) => {
    const order = ["a1", source.key, "a2", "a3"];
    const result = plan({
      activeKey: source.key,
      activeSection: source.section,
      target: { section: "active", pinnedOrder: [], activeOrder: order },
    });
    expect(result).toEqual({
      kind: "move-active",
      order,
      assignments: [{ id: source.key, orderKey: expect.any(String) }],
      unpin: source.unpin,
      unsettle: source.unsettle,
      unsnooze: source.unsnooze,
    });
    if (result.kind !== "move-active") return;
    const key = result.assignments[0]!.orderKey;
    expect(key > "f" && key < "m").toBe(true);
  });
  it.each([
    { state: "pinned", activePinned: true, activeSettled: false },
    { state: "settled", activePinned: false, activeSettled: true },
    { state: "pinned and settled", activePinned: true, activeSettled: true },
  ])("clears a snoozed thread's $state state before waking it into Active", (hiddenState) => {
    expect(
      plan({
        activeKey: "z1",
        activeSection: "snoozed",
        activePinned: hiddenState.activePinned,
        activeSettled: hiddenState.activeSettled,
        target: {
          section: "active",
          pinnedOrder: ["p1", "p2", "p3"],
          activeOrder: ["a1", "z1", "a2", "a3"],
        },
      }),
    ).toEqual({
      kind: "move-active",
      order: ["a1", "z1", "a2", "a3"],
      assignments: [{ id: "z1", orderKey: expect.any(String) }],
      unpin: hiddenState.activePinned,
      unsettle: hiddenState.activeSettled,
      unsnooze: true,
    });
  });
  it("saves the first Active reorder, then moves only one key on subsequent drops", () => {
    const rows = ["a1", "a2", "a3"].map((id, index) => ({
      id,
      createdAt: new Date(Date.UTC(2026, 8, 4, 12 - index)).toISOString(),
      activeOrderKey: null as string | null,
    }));
    const firstOrder = ["a2", "a3", "a1"];
    const first = plan({
      activeKey: "a1",
      activeSection: "active",
      target: { section: "active", pinnedOrder: [], activeOrder: firstOrder },
      activeKeysById: new Map(rows.map((row) => [row.id, row.activeOrderKey])),
    });
    expect(first.kind).toBe("move-active");
    if (first.kind !== "move-active") return;
    expect(first.unpin || first.unsettle || first.unsnooze).toBe(false);
    const savedKeys = new Map(first.assignments.map(({ id, orderKey }) => [id, orderKey]));
    const savedRows = rows.map((row) => ({
      ...row,
      activeOrderKey: savedKeys.get(row.id) ?? null,
    }));
    expect(sortThreadsForSidebar(savedRows).map((row) => row.id)).toEqual(firstOrder);

    const secondOrder = ["a2", "a1", "a3"];
    const second = plan({
      activeKey: "a1",
      activeSection: "active",
      activeOrder: firstOrder,
      activeKeysById: savedKeys,
      target: { section: "active", pinnedOrder: [], activeOrder: secondOrder },
    });
    expect(second.kind).toBe("move-active");
    if (second.kind !== "move-active") return;
    expect(second.assignments).toEqual([{ id: "a1", orderKey: expect.any(String) }]);
    const finalRows = savedRows.map((row) =>
      row.id === "a1" ? { ...row, activeOrderKey: second.assignments[0]!.orderKey } : row,
    );
    expect(sortThreadsForSidebar(finalRows).map((row) => row.id)).toEqual(secondOrder);
  });
  it("requires Active ordering support only for the threads whose keys must change", () => {
    const input = {
      activeKey: "a3",
      activeSection: "active" as const,
      target: { section: "active" as const, pinnedOrder: [], activeOrder: ["a1", "a3", "a2"] },
      activeReorderableKeys: new Set(["a3"]),
    };
    expect(plan(input).kind).toBe("move-active");
    expect(
      plan({
        ...input,
        activeKeysById: new Map([
          ["a1", null],
          ["a2", "m"],
          ["a3", "t"],
        ]),
      }),
    ).toMatchObject({
      kind: "move-active",
      assignments: [{ id: "a3", orderKey: expect.any(String) }],
    });
    expect(plan({ ...input, activeReorderableKeys: new Set() })).toEqual({ kind: "none" });
  });
  it("reorders an already-pinned snoozed thread after pinning wakes it", () => {
    const result = plan({
      activeKey: "z1",
      activeSection: "snoozed",
      activePinned: true,
      target: { section: "pinned", pinnedOrder: ["p1", "z1", "p2", "p3"] },
      pinnedKeysById: new Map([...pinnedKeysById, ["z1", "x"]]),
    });
    expect(result.kind).toBe("pin");
    if (result.kind !== "pin") return;
    expect(result.extraAssignments).toEqual([{ id: "z1", orderKey: result.orderKey }]);
    expect(result.orderKey! > "f" && result.orderKey! < "m").toBe(true);
  });
  it("uses keyed disabled neighbors as anchors without writing to them", () => {
    const insertion = plan({
      activeKey: "a1",
      activeSection: "active",
      target: { section: "pinned", pinnedOrder: ["p1", "a1", "p2", "p3"] },
      reorderableKeys: new Set(["a1"]),
    });
    expect(insertion.kind).toBe("pin");
    if (insertion.kind !== "pin") return;
    expect(insertion.order).toEqual(["p1", "a1", "p2", "p3"]);
    expect(insertion.orderKey! > "f" && insertion.orderKey! < "m").toBe(true);
    expect(insertion.extraAssignments).toEqual([]);

    const reorder = plan({
      activeKey: "p3",
      activeSection: "pinned",
      target: { section: "pinned", pinnedOrder: ["p1", "p3", "p2"] },
      reorderableKeys: new Set(["p3"]),
    });
    expect(reorder.kind).toBe("reorder-pinned");
    if (reorder.kind !== "reorder-pinned") return;
    expect(reorder.assignments).toEqual([{ id: "p3", orderKey: expect.any(String) }]);
    expect(reorder.assignments[0]!.orderKey > "f").toBe(true);
    expect(reorder.assignments[0]!.orderKey < "m").toBe(true);
  });
  it.each([
    {
      activeKey: "a1",
      activeSection: "active" as const,
      order: ["p1", "p3", "a1", "p2"],
    },
    { activeKey: "p1", activeSection: "pinned" as const, order: ["p3", "p1", "p2"] },
  ])("leaves a keyless disabled neighbor untouched on $activeSection drops", (source) => {
    expect(
      plan({
        activeKey: source.activeKey,
        activeSection: source.activeSection,
        target: { section: "pinned", pinnedOrder: source.order },
        pinnedOrder: ["p1", "p3", "p2"],
        pinnedKeysById: new Map([
          ["p1", "f"],
          ["p2", null],
          ["p3", "t"],
        ]),
        reorderableKeys: new Set(["p1", "p3", source.activeKey]),
      }),
    ).toMatchObject(
      source.activeSection === "active"
        ? { kind: "pin", extraAssignments: [] }
        : { kind: "reorder-pinned", assignments: [{ id: "p1", orderKey: expect.any(String) }] },
    );
  });
  it("rewrites the section when a foreign thread lands next to a keyless pin", () => {
    const result = plan({
      activeKey: "a1",
      activeSection: "active",
      target: { section: "pinned", pinnedOrder: ["p1", "a1", "p2", "p3"] },
      pinnedKeysById: new Map([
        ["p1", null],
        ["p2", "m"],
        ["p3", "t"],
      ]),
    });
    expect(result.kind).toBe("pin");
    if (result.kind !== "pin") return;
    expect(result.orderKey).toBeDefined();
    expect(result.extraAssignments.map((entry) => entry.id)).toEqual(["p1", "p2", "p3"]);
    const byId = new Map([
      ["a1", result.orderKey!],
      ...result.extraAssignments.map((e) => [e.id, e.orderKey] as const),
    ]);
    const ordered = result.order.map((id) => byId.get(id)!);
    expect([...ordered].sort()).toEqual(ordered);
  });
});
describe("applySidebarThreadDrop", () => {
  const createdAt = "2026-03-09T08:00:00.000Z";
  const earlier = "2026-03-09T09:00:00.000Z";
  const now = "2026-03-09T12:00:00.000Z";
  const serverNow = "2026-03-09T12:00:01.000Z";
  const wakeAt = "2026-03-10T08:00:00.000Z";
  const thread = (overrides: Partial<SidebarThreadSummary> = {}) => ({
    id: ThreadId.make("dragged"),
    title: "Keep this title",
    createdAt,
    updatedAt: earlier,
    latestUserMessageAt: null,
    latestRun: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    snoozedAt: null,
    snoozedUntil: null,
    settledAt: null,
    settledOverride: null,
    unsettledAt: null,
    ...overrides,
  });
  const newer = thread({ id: ThreadId.make("newer"), createdAt: "2026-03-09T11:00:00.000Z" });
  it("previews an un-settle at the same active position as the eventual server row", () => {
    const source = thread({ settledOverride: "settled", settledAt: earlier });
    const preview = applySidebarThreadDrop(source, "active", now);
    const final = {
      ...source,
      settledOverride: "active" as const,
      settledAt: null,
      unsettledAt: serverNow,
    };
    expect(sortThreadsForSidebar([newer, preview]).map((row) => row.id)).toEqual([
      "dragged",
      "newer",
    ]);
    expect(sortThreadsForSidebar([newer, preview]).map((row) => row.id)).toEqual(
      sortThreadsForSidebar([newer, final]).map((row) => row.id),
    );
  });
  it.each([
    { state: "pin", pinnedAt: earlier, pinOrderKey: "m", snoozedAt: null, snoozedUntil: null },
    {
      state: "snooze",
      pinnedAt: null,
      pinOrderKey: null,
      snoozedAt: earlier,
      snoozedUntil: wakeAt,
    },
    {
      state: "snoozed pin",
      pinnedAt: earlier,
      pinOrderKey: "m",
      snoozedAt: earlier,
      snoozedUntil: wakeAt,
    },
  ])("preserves the active sort anchor when clearing a $state", ({ state: _state, ...parked }) => {
    const source = thread({ ...parked, settledOverride: "active", unsettledAt: earlier });
    const preview = applySidebarThreadDrop(source, "active", now);
    const final = {
      ...source,
      pinnedAt: null,
      pinOrderKey: null,
      snoozedAt: null,
      snoozedUntil: null,
      updatedAt: serverNow,
    };
    expect(preview).toEqual({ ...final, updatedAt: source.updatedAt });
    expect(sortThreadsForSidebar([newer, preview]).map((row) => row.id)).toEqual([
      "newer",
      "dragged",
    ]);
    expect(sortThreadsForSidebar([newer, preview]).map((row) => row.id)).toEqual(
      sortThreadsForSidebar([newer, final]).map((row) => row.id),
    );
  });
  it("retains a snoozed thread's earlier settlement and its position when settling again", () => {
    const source = thread({
      snoozedAt: earlier,
      snoozedUntil: wakeAt,
      settledOverride: "settled",
      settledAt: earlier,
    });
    const preview = applySidebarThreadDrop(source, "settled", now);
    const final = { ...source, snoozedAt: null, snoozedUntil: null };
    const existing = { ...newer, settledOverride: "settled" as const, settledAt: newer.createdAt };
    expect(preview).toEqual(final);
    expect(sortSettledThreads([existing, preview]).map((row) => row.id)).toEqual([
      "newer",
      "dragged",
    ]);
  });
  it("clears the manual Active position when settling so reopening returns to the top", () => {
    const source = thread({ activeOrderKey: "z" });
    const settled = applySidebarThreadDrop(source, "settled", now);
    expect(settled.activeOrderKey).toBeNull();
    const reopened = applySidebarThreadDrop(settled, "active", serverNow);
    expect(sortThreadsForSidebar([newer, reopened]).map((row) => row.id)).toEqual([
      "dragged",
      "newer",
    ]);
  });
});
