import { act, render as renderUi, fakeTimers, type Screen } from "../../../test/render";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { restartGuidedTour, updateGuidedTourState } from "../../onboarding/guidedTourState";
import type { TimelineEntry } from "../../session-logic";
import { useGuidedTourChatGuide, type GuidedTourChatGuideInput } from "./GuidedTourChatGuide";

const mocks = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(select: (settings: { experimentalGuidedTourEnabled: boolean }) => T) =>
    select({ experimentalGuidedTourEnabled: mocks.enabled }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
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

describe("guided tour chat guide", () => {
  it("stays out of every conversation while the experiment is off", async () => {
    await using _fixture = await setupTest();

    mocks.enabled = false;
    await _fixture.render(_fixture.baseInput());
    expect(_fixture.container.textContent).toBe("");
  });

  it("only appears in the conversation the tour started", async () => {
    await using _fixture = await setupTest();

    await _fixture.render(_fixture.baseInput({ threadId: ThreadId.make("someone-elses-chat") }));
    expect(_fixture.container.textContent).toBe("");
    await _fixture.render(_fixture.baseInput({ environmentId: EnvironmentId.make("remote") }));
    expect(_fixture.container.textContent).toBe("");
  });

  it("describes only what the current run has really done", async () => {
    await using _fixture = await setupTest();

    await _fixture.render(
      _fixture.baseInput({
        isWorking: true,
        run: { runId: "run-2", status: "running", startedAt: null, requestedAt: null },
        timelineEntries: [
          work("run-1", "microsoft365_calendar_events"),
          work("run-2", "microsoft365_mail_search"),
        ],
      }),
    );
    expect(_fixture.container.textContent).toContain("Working on it");
    expect(_fixture.container.textContent).toContain("Searching your email");
    expect(_fixture.container.textContent).not.toContain("Reading your calendar");
  });

  it("tells a question apart from a request to approve", async () => {
    await using _fixture = await setupTest();

    await _fixture.render(_fixture.baseInput({ isWorking: true, hasPendingQuestion: true }));
    expect(_fixture.container.textContent).toContain("It has a question for you");
    expect(_fixture.container.textContent).not.toContain("Approve");
    await _fixture.render(_fixture.baseInput({ isWorking: true, hasPendingApproval: true }));
    expect(_fixture.container.textContent).toContain("Choose Approve to let it, or Decline");
  });

  it("offers each follow-up once, and only marks it used after it really sent", async () => {
    await using _fixture = await setupTest();

    const send = vi.fn(async () => false);
    await _fixture.render(_fixture.baseInput({ send }));
    expect(_fixture.buttons()).toContain("Which line has the most left?");

    await _fixture.click("Which line has the most left?");
    expect(send).toHaveBeenCalledWith("Which line has the most left?");
    expect(_fixture.buttons()).toContain("Which line has the most left?");

    send.mockResolvedValue(true);
    await _fixture.click("Which line has the most left?");
    expect(_fixture.buttons()).not.toContain("Which line has the most left?");
    expect(_fixture.buttons()).toContain("Save this as a new spreadsheet");
  });

  it("sends the last request again after a run stops early", async () => {
    await using _fixture = await setupTest();

    const send = vi.fn(async () => true);
    await _fixture.render(
      _fixture.baseInput({
        send,
        run: { runId: "run-3", status: "interrupted", startedAt: null, requestedAt: null },
        timelineEntries: [userMessage("Check the budget below"), userMessage("Which line?")],
      }),
    );
    expect(_fixture.container.textContent).toContain("It stopped before finishing");
    await _fixture.click("Try again");
    expect(send).toHaveBeenCalledWith("Which line?");
  });

  it("does not offer a text-only retry for a request that carried a file", async () => {
    await using _fixture = await setupTest();

    const withFile = {
      ...userMessage('Check the attached file "Mine.csv"'),
    } as unknown as { message: Record<string, unknown> };
    withFile.message = { ...withFile.message, attachments: [{ type: "file", id: "a1" }] };
    await _fixture.render(
      _fixture.baseInput({
        run: { runId: "run-3", status: "failed", startedAt: null, requestedAt: null },
        timelineEntries: [withFile as unknown as TimelineEntry],
      }),
    );
    expect(_fixture.container.textContent).toContain("It stopped before finishing");
    expect(_fixture.container.textContent).toContain("attach it again with the paperclip");
    expect(_fixture.buttons()).not.toContain("Try again");
  });

  it("stays hidden once dismissed", async () => {
    await using _fixture = await setupTest();

    await _fixture.render(_fixture.baseInput());
    await _fixture.click("Hide tour suggestions");
    expect(_fixture.container.textContent).toBe("");
  });
});

async function setupTest() {
  const stack = new AsyncDisposableStack();
  let container: HTMLElement;
  let screen: Screen | undefined;

  async function renderSubject(node: import("react").ReactNode) {
    if (screen) await screen.rerender(node);
    else {
      screen = stack.use(
        await renderUi(node, {
          router: false /* These subjects use mocked navigation or no routing. */,
        }),
      );
      container = screen.container;
    }
  }

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
    await act(async () => renderSubject(<Guide {...input} />));
  }

  const buttons = () =>
    [...container.querySelectorAll("button")].map((button) => button.textContent);

  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes(label),
    );
    if (!button) throw new Error(`No button "${label}"`);
    await act(async () => button.click());
  }

  screen = undefined;
  mocks.enabled = true;
  restartGuidedTour();
  updateGuidedTourState({
    roleId: "finance",
    taskId: "finance-budget",
    taskEnvironmentId: environmentId,
    taskThreadId: threadId,
  });
  return {
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
    stack,
    get container() {
      return container;
    },
    set container(value: typeof container) {
      container = value;
    },
    get screen() {
      return screen;
    },
    set screen(value: typeof screen) {
      screen = value;
    },
    renderSubject,
    baseInput,
    render,
    buttons,
    click,
  };
}
