import {
  DEFAULT_GETTING_STARTED_PROGRESS,
  EnvironmentId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type GettingStartedChapterId,
  type GettingStartedProgress,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../session-logic";
import type { ChatMessage } from "../types";
import { reduceGettingStarted, type GettingStartedEvent } from "./gettingStarted.logic";
import { gettingStartedRunEvents, type GettingStartedRun } from "./gettingStartedEvidence";

const ENVIRONMENT = EnvironmentId.make("guide-evidence");
const THREAD = ThreadId.make("guide-practice");
const AT = "2026-10-22T10:00:00.000Z";
const RUN_AT = "2026-10-22T10:01:00.000Z";
const MAIL_TOOL = "microsoft365_mail_search";

function task(chapter: GettingStartedChapterId = "conversation") {
  const events: GettingStartedEvent[] = [
    { type: "start", environmentId: ENVIRONMENT, at: AT },
    { type: "select", chapter },
    {
      type: "track",
      chapter,
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      at: AT,
      toolNames: chapter === "connected-work" ? [MAIL_TOOL] : [],
    },
    ...["M1", "M2"].map((messageId): GettingStartedEvent => ({
      type: "submitted",
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      messageId,
    })),
  ];
  return events.reduce(reduceGettingStarted, DEFAULT_GETTING_STARTED_PROGRESS);
}

function run(runId = "R1", overrides: Partial<GettingStartedRun> = {}): GettingStartedRun {
  return {
    runId,
    status: "completed",
    userMessageId: runId === "R1" ? "M1" : "M2",
    startedAt: RUN_AT,
    ...overrides,
  };
}

function message(
  overrides: Partial<ChatMessage> = {},
): Extract<TimelineEntry, { kind: "message" }> {
  const item: ChatMessage = {
    id: MessageId.make("R1-answer"),
    role: "assistant",
    runId: RunId.make("R1"),
    text: "Here is the result.",
    streaming: false,
    createdAt: RUN_AT,
    updatedAt: RUN_AT,
    ...overrides,
  };
  return { id: item.id, kind: "message", createdAt: item.createdAt, message: item };
}

function mailResult(
  output: unknown,
  overrides: Partial<WorkLogEntry> = {},
): Extract<TimelineEntry, { kind: "work" }> {
  return {
    id: "mail-result",
    kind: "work",
    createdAt: RUN_AT,
    entry: {
      id: "mail-result",
      createdAt: RUN_AT,
      runId: RunId.make("R1"),
      label: "Search mail",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      structuredPayload: {
        type: "dynamic_tool",
        id: TurnItemId.make("mail-result"),
        threadId: THREAD,
        runId: RunId.make("R1"),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: DateTime.makeUnsafe(RUN_AT),
        completedAt: DateTime.makeUnsafe(RUN_AT),
        updatedAt: DateTime.makeUnsafe(RUN_AT),
        toolName: `t3-code.${MAIL_TOOL}`,
        input: { query: "meeting" },
        output,
      },
      ...overrides,
    },
  };
}

/** The runs a thread's turn items would mark as answered for these fixture messages. */
function answered(entries: ReadonlyArray<TimelineEntry>): ReadonlySet<string> {
  return new Set(
    entries.flatMap((item) =>
      item.kind === "message" &&
      item.message.role === "assistant" &&
      item.message.runId &&
      !item.message.streaming
        ? [item.message.runId]
        : [],
    ),
  );
}

function observe(
  state: GettingStartedProgress,
  runs: ReadonlyArray<GettingStartedRun>,
  timelineEntries: ReadonlyArray<TimelineEntry>,
) {
  return gettingStartedRunEvents({
    state,
    environmentId: ENVIRONMENT,
    threadId: THREAD,
    runs,
    timelineEntries,
    answeredRunIds: answered(timelineEntries),
    skills: [],
  });
}

describe("completed run evidence", () => {
  it("retains the first completed practice run while a newer follow-up is queued", () => {
    const initial = task();
    const firstEvents = observe(initial, [run(), run("R2", { status: "queued" })], [message()]);
    expect(firstEvents).toMatchObject([
      { type: "run", runId: "R1", userMessageId: "M1", generation: initial.generation },
    ]);
    const first = firstEvents.reduce(reduceGettingStarted, initial);
    expect(first.tasks[0]?.runIds).toEqual(["R1"]);
    expect(first.completed).toEqual([]);

    const nextEvents = observe(
      first,
      [run(), run("R2")],
      [message(), message({ id: MessageId.make("R2-answer"), runId: RunId.make("R2") })],
    );
    expect(nextEvents).toMatchObject([{ runId: "R2", userMessageId: "M2" }]);
    const second = nextEvents.reduce(reduceGettingStarted, first);
    expect(second.tasks[0]?.runIds).toEqual(["R1", "R2"]);
    expect(second.completed).toEqual([]);
    const checked = reduceGettingStarted(second, {
      type: "checked-source",
      environmentId: ENVIRONMENT,
      threadId: THREAD,
    });
    expect(checked.completed).toEqual(["conversation"]);
    expect(observe(checked, [run(), run("R2")], [message()])).toEqual([]);
  });

  it.each([
    "preparing",
    "queued",
    "starting",
    "running",
    "waiting",
    "failed",
    "cancelled",
    "interrupted",
    "rolled_back",
  ] as const)("does not count a %s run even with partial answer text", (status) => {
    expect(observe(task(), [run("R1", { status })], [message()])).toEqual([]);
  });

  it.each<Partial<ChatMessage>>([
    { streaming: true },
    { role: "user" },
    { runId: RunId.make("another-run") },
  ])("requires a final assistant answer belonging to this run: %j", (change) => {
    expect(observe(task(), [run()], [message(change)])).toEqual([]);
  });

  it("does not bind another submission, environment, or thread to the tracked task", () => {
    const state = task();
    const input = {
      state,
      environmentId: ENVIRONMENT,
      threadId: THREAD,
      runs: [run()],
      timelineEntries: [message()],
      answeredRunIds: answered([message()]),
      skills: [],
    };
    expect(
      observe(state, [run("R1", { userMessageId: "not-submitted-here" })], [message()]),
    ).toEqual([]);
    expect(
      gettingStartedRunEvents({ ...input, environmentId: EnvironmentId.make("other") }),
    ).toEqual([]);
    expect(gettingStartedRunEvents({ ...input, threadId: ThreadId.make("other") })).toEqual([]);
  });
});

describe("connected work result evidence", () => {
  it.each([
    { label: "isError", output: { isError: true } },
    { label: "is_error", output: { is_error: true } },
    { label: "error field", output: { error: "Access denied" } },
    { label: "orchestrator rejection", output: { _tag: "OrchestratorMcpFailure" } },
    { label: "serialized envelope", output: JSON.stringify({ isError: true }) },
    { label: "structured envelope", output: { structuredContent: { isError: true } } },
    {
      label: "MCP text content",
      output: { content: [{ type: "text", text: JSON.stringify({ isError: true }) }] },
    },
    { label: "command failure text", output: "Command exited with exit code 1" },
  ])("does not complete mail practice for a completed tool carrying $label", ({ output }) => {
    const state = task("connected-work");
    const events = observe(state, [run()], [message(), mailResult(output)]);

    expect(events).toEqual([]);
    expect(events.reduce(reduceGettingStarted, state)).toBe(state);
    expect(state.completed).toEqual([]);
  });

  it("does not borrow a successful mail result from another run or an unrelated tool", () => {
    const state = task("connected-work");
    const wrongRun = mailResult({}, { runId: RunId.make("R2") });
    const wrongTool = mailResult({});
    if (wrongTool.entry.structuredPayload?.type !== "dynamic_tool")
      throw new Error("Invalid tool fixture");
    const unrelated: TimelineEntry = {
      ...wrongTool,
      entry: {
        ...wrongTool.entry,
        structuredPayload: {
          ...wrongTool.entry.structuredPayload,
          toolName: "t3-code.github_search",
        },
      },
    };
    const events = observe(state, [run()], [message(), wrongRun, unrelated]);

    expect(events).toEqual([]);
    expect(events.reduce(reduceGettingStarted, state)).toBe(state);
  });
});

describe("approval and skill evidence", () => {
  const userMessage = (text: string) =>
    message({ id: MessageId.make("M1"), role: "user", runId: null, text });
  const approval: TimelineEntry = {
    id: "approval",
    kind: "work",
    createdAt: RUN_AT,
    entry: {
      id: "approval",
      createdAt: RUN_AT,
      runId: RunId.make("R1"),
      label: "Approval requested",
      tone: "tool",
      itemType: "approval_request",
      structuredPayload: {
        type: "approval_request",
        id: TurnItemId.make("approval"),
        threadId: THREAD,
        runId: RunId.make("R1"),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: DateTime.makeUnsafe(RUN_AT),
        completedAt: DateTime.makeUnsafe(RUN_AT),
        updatedAt: DateTime.makeUnsafe(RUN_AT),
        requestId: RuntimeRequestId.make("approval-1"),
        requestKind: "file-change",
      },
    },
  };

  it("completes the approvals chapter only after a run that asked for approval", () => {
    const state = task("approvals");
    const entries = [userMessage("Save the to-do list"), message()];

    expect(observe(state, [run()], entries)).toEqual([]);
    const events = observe(state, [run()], [...entries, approval]);
    expect(events.reduce(reduceGettingStarted, state).completed).toEqual(["approvals"]);
  });

  it("completes the skills chapter only when the request names an installed skill", () => {
    const state = task("skills");
    const entries = [userMessage("$writing-coach What can you help with?"), message()];
    const withSkills = (skills: ReadonlyArray<{ name: string }>) =>
      gettingStartedRunEvents({
        state,
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        runs: [run()],
        timelineEntries: entries,
        answeredRunIds: answered(entries),
        skills,
      });

    expect(withSkills([{ name: "other-skill" }])).toEqual([]);
    expect(
      withSkills([{ name: "writing-coach" }]).reduce(reduceGettingStarted, state).completed,
    ).toEqual(["skills"]);
  });
});
