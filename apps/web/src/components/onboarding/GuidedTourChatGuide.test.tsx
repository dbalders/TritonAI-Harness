// @vitest-environment jsdom
import { DEFAULT_GETTING_STARTED_PROGRESS, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { restartGuidedTour, updateGuidedTourState } from "../../onboarding/guidedTourState";
import type { TimelineEntry } from "../../session-logic";
import { useGuidedTourChatGuide, type GuidedTourChatGuideInput } from "./GuidedTourChatGuide";

const mocks = vi.hoisted(() => ({
  enabled: true,
  integratedActive: false,
  integratedThread: "tour-thread",
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(
    select: (settings: {
      experimentalGuidedTourEnabled: boolean;
      gettingStarted: typeof DEFAULT_GETTING_STARTED_PROGRESS;
    }) => T,
  ) =>
    select({
      experimentalGuidedTourEnabled: mocks.enabled,
      gettingStarted: {
        ...DEFAULT_GETTING_STARTED_PROGRESS,
        startedAt: mocks.integratedActive ? "2026-10-22T10:00:00Z" : null,
        environmentId,
        activeChapter: "conversation",
        tasks: mocks.integratedActive
          ? [
              {
                chapter: "conversation",
                environmentId,
                threadId: ThreadId.make(mocks.integratedThread),
                after: "2026-10-22T10:00:00Z",
                messageIds: [],
                toolNames: [],
                runIds: [],
                checkedSource: false,
              },
            ]
          : [],
      },
    }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { readonly children: ReactNode }) => (
    <a href="/settings/plugins">{children}</a>
  ),
}));

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("tour-thread");

function work(runId: string, toolTitle: string): TimelineEntry {
  return {
    id: `${runId}:${toolTitle}`,
    kind: "work",
    createdAt: "2026-10-20T10:00:00.000Z",
    entry: {
      id: `${runId}:${toolTitle}`,
      createdAt: "2026-10-20T10:00:00.000Z",
      runId,
      label: "Tool call",
      tone: "tool",
      toolTitle,
      toolSource: { key: "microsoft-365", name: "Microsoft 365", kind: "integration" },
    },
  } as unknown as TimelineEntry;
}

function userMessage(text: string): TimelineEntry {
  return {
    id: text,
    kind: "message",
    createdAt: "2026-10-20T10:00:00.000Z",
    message: { id: text, role: "user", text, createdAt: "2026-10-20T10:00:00.000Z" },
  } as unknown as TimelineEntry;
}

function Guide(props: GuidedTourChatGuideInput) {
  const item = useGuidedTourChatGuide(props);
  if (!item) return null;
  return (
    <section>
      <h2>{item.title}</h2>
      <p>{item.description}</p>
      {item.children}
      {item.actions}
      <button type="button" onClick={item.onDismiss}>
        {item.dismissLabel}
      </button>
    </section>
  );
}

let container: HTMLDivElement;
let root: Root;

const baseInput = (patch: Partial<GuidedTourChatGuideInput> = {}): GuidedTourChatGuideInput => ({
  environmentId,
  threadId,
  run: { runId: "run-2", status: "completed", startedAt: null, requestedAt: null },
  isWorking: false,
  hasPendingApproval: false,
  hasPendingQuestion: false,
  timelineEntries: [],
  send: async () => true,
  ...patch,
});

async function render(input: GuidedTourChatGuideInput) {
  await act(async () => root.render(<Guide {...input} />));
}

const buttons = () => [...container.querySelectorAll("button")].map((button) => button.textContent);

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  if (!button) throw new Error(`No button "${label}"`);
  await act(async () => button.click());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.enabled = true;
  mocks.integratedActive = false;
  mocks.integratedThread = "tour-thread";
  restartGuidedTour();
  updateGuidedTourState({
    roleId: "finance",
    taskId: "finance-budget",
    taskEnvironmentId: environmentId,
    taskThreadId: threadId,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("guided tour chat guide", () => {
  it("stays out of every conversation while the experiment is off", async () => {
    mocks.enabled = false;
    await render(baseInput());
    expect(container.textContent).toBe("");
  });

  it("lets the integrated guide own the conversation while it is active", async () => {
    mocks.integratedActive = true;
    await render(baseInput());
    expect(container.textContent).toBe("");
  });

  it("keeps the experimental coach available when the integrated exercise belongs to another conversation", async () => {
    mocks.integratedActive = true;
    mocks.integratedThread = "another-guide-thread";
    await render(baseInput());
    expect(container.textContent).not.toBe("");
  });

  it("only appears in the conversation the tour started", async () => {
    await render(baseInput({ threadId: ThreadId.make("someone-elses-chat") }));
    expect(container.textContent).toBe("");
    await render(baseInput({ environmentId: EnvironmentId.make("remote") }));
    expect(container.textContent).toBe("");
  });

  it("describes only what the current run has really done", async () => {
    await render(
      baseInput({
        isWorking: true,
        run: { runId: "run-2", status: "running", startedAt: null, requestedAt: null },
        timelineEntries: [
          work("run-1", "microsoft365_calendar_events"),
          work("run-2", "microsoft365_mail_search"),
        ],
      }),
    );
    expect(container.textContent).toContain("Working on it");
    expect(container.textContent).toContain("Searching your email");
    expect(container.textContent).not.toContain("Reading your calendar");
  });

  it("tells a question apart from a request to approve", async () => {
    await render(baseInput({ isWorking: true, hasPendingQuestion: true }));
    expect(container.textContent).toContain("It has a question for you");
    expect(container.textContent).not.toContain("Approve");
    await render(baseInput({ isWorking: true, hasPendingApproval: true }));
    expect(container.textContent).toContain("Choose Approve to let it, or Decline");
  });

  it("offers each follow-up once, and only marks it used after it really sent", async () => {
    const send = vi.fn(async () => false);
    await render(baseInput({ send }));
    expect(buttons()).toContain("Which line has the most left?");

    await click("Which line has the most left?");
    expect(send).toHaveBeenCalledWith("Which line has the most left?");
    expect(buttons()).toContain("Which line has the most left?");

    send.mockResolvedValue(true);
    await click("Which line has the most left?");
    expect(buttons()).not.toContain("Which line has the most left?");
    expect(buttons()).toContain("Save this as a new spreadsheet");
  });

  it("sends the last request again after a run stops early", async () => {
    const send = vi.fn(async () => true);
    await render(
      baseInput({
        send,
        run: { runId: "run-3", status: "interrupted", startedAt: null, requestedAt: null },
        timelineEntries: [userMessage("Check the budget below"), userMessage("Which line?")],
      }),
    );
    expect(container.textContent).toContain("It stopped before finishing");
    await click("Try again");
    expect(send).toHaveBeenCalledWith("Which line?");
  });

  it("does not offer a text-only retry for a request that carried a file", async () => {
    const withFile = {
      ...userMessage('Check the attached file "Mine.csv"'),
    } as unknown as { message: Record<string, unknown> };
    withFile.message = { ...withFile.message, attachments: [{ type: "file", id: "a1" }] };
    await render(
      baseInput({
        run: { runId: "run-3", status: "failed", startedAt: null, requestedAt: null },
        timelineEntries: [withFile as unknown as TimelineEntry],
      }),
    );
    expect(container.textContent).toContain("It stopped before finishing");
    expect(container.textContent).toContain("attach it again with the paperclip");
    expect(buttons()).not.toContain("Try again");
  });

  it("stays hidden once dismissed", async () => {
    await render(baseInput());
    await click("Hide tour suggestions");
    expect(container.textContent).toBe("");
  });
});
