// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./botService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./botService")>()),
  useBotServiceUrl: () => "https://bot.example.test",
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: vi.fn() } }),
}));

import { DotPage } from "./DotPage";
import { saveDotSession, type DotState } from "./dotClient";
import type { DotScheduledPrompt } from "./dotRoutines";

const serviceUrl = "https://bot.example.test";
const session = {
  ownerToken: "synthetic-owner-token",
  expiresAt: Date.now() / 1000 + 3600,
  email: "owner@example.test",
};
const at = "2026-10-08T12:00:00Z";
const prompt: DotScheduledPrompt = {
  promptId: "sp_123456789abc",
  name: "Morning check",
  prompt: "Check my calendar",
  schedule: { kind: "daily", time: "08:00" },
  scheduleText: "Every day at 8",
  timezone: "America/Los_Angeles",
  threadId: "routine",
  notify: "if-notable",
  enabled: true,
  nextRunAt: "2026-10-09T15:00:00Z",
  consecutiveUnread: 0,
  spendGuard: true,
  createdAt: at,
  updatedAt: at,
};
function snapshot(): DotState {
  return {
    user: { userId: "owner", email: session.email, controlVersion: 3 },
    tasks: [],
    approvals: [],
    runs: [],
  };
}
function withPanels(): DotState {
  return {
    ...snapshot(),
    feedback: [],
    handling: {
      generatedAt: at,
      paused: false,
      timezone: "America/Los_Angeles",
      unavailable: [],
      items: [
        {
          kind: "reminder",
          id: "reminder1",
          title: "Check report",
          state: "scheduled",
          version: "opaque-v1",
          controls: ["stop"],
        },
      ],
    },
    watches: [],
    scheduledPrompts: [prompt],
    capabilities: [
      {
        id: "notes",
        description: "Keep notes",
        examples: ["Remember this deadline"],
        availability: { status: "available" },
      },
    ],
    microsoft: {
      health: {
        userId: "owner",
        version: 1,
        generation: at,
        areas: { calendar: { status: "needs-reconnect", since: at, generation: at } },
      },
    },
  };
}

let root: Root;
let container: HTMLDivElement;
let state: DotState;
let onPost: (path: string, body: Record<string, unknown>) => Promise<Response>;
let onTaskRead: (taskId: string) => Promise<Response>;
let onApprovalRead: (approvalId: string) => Promise<Response>;
let requests: { path: string; body: Record<string, unknown> }[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state = snapshot();
  requests = [];
  onPost = async () => Response.json({ ok: true });
  onTaskRead = async () => Response.json({ ok: false, error: "Task unavailable" }, { status: 404 });
  onApprovalRead = async () =>
    Response.json({ ok: false, error: "Approval unavailable" }, { status: 404 });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ path, body });
        return onPost(path, body);
      }
      if (path === "/state") return Response.json({ ok: true, ...state });
      if (path.startsWith("/owner-memory/")) {
        const memory = state.dotMemory?.find((item) => item.memoryId === path.slice(14));
        return Response.json(
          memory ? { ok: true, memory } : { ok: false, error: "Memory unavailable" },
          { status: memory ? 200 : 404 },
        );
      }
      if (path.startsWith("/tasks/")) return onTaskRead(path.slice(7));
      if (path.startsWith("/approvals/")) return onApprovalRead(path.slice(11));
      if (path.startsWith("/runs/"))
        return Response.json({
          ok: true,
          run: {
            runId: path.slice(6),
            threadId: "routine",
            event: { kind: "message" },
            status: "completed",
            createdAt: at,
            updatedAt: at,
            result: { summary: "Routine result" },
          },
        });
      throw new Error(`Unexpected GET ${path}`);
    }),
  );
  sessionStorage.clear();
  saveDotSession(sessionStorage, serviceUrl, session);
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<DotPage />));
}
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Button missing: ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

describe("TritonAI Bot page integration", () => {
  it("keeps chat usable and hides unsupported panels and ratings on an older bot", async () => {
    state = {
      ...snapshot(),
      runs: [
        {
          runId: "brief",
          threadId: "dot",
          event: { kind: "routine" },
          status: "completed",
          createdAt: at,
          updatedAt: at,
          result: { summary: "Your briefing" },
        },
      ],
    };
    await render();
    expect(container.textContent).toContain("Your briefing");
    expect(container.querySelector('[aria-label="Message your bot"]')).not.toBeNull();
    expect(container.querySelector("aside")).toBeNull();
    expect(container.textContent).not.toContain("What the bot is handling");
    expect(container.textContent).not.toContain("What I can do");
    expect(container.textContent).not.toContain("Watches & routines");
    expect(container.textContent).not.toContain("Useful");
  });

  it("uses the optional panels and stops a confirmed versioned item, then refreshes it", async () => {
    state = withPanels();
    onPost = async (path) => {
      if (path.includes("/handling/")) {
        state = { ...state, handling: { ...state.handling!, items: [] } };
        return Response.json({
          ok: true,
          stopped: true,
          outcome: "stopped",
          kind: "reminder",
          id: "reminder1",
          message: "Reminder stopped.",
        });
      }
      return Response.json({ ok: true });
    };
    await render();
    expect(container.textContent).toContain("What the bot is handling");
    expect(container.textContent).toContain("Watches & routines");
    expect(container.textContent).toContain("What I can do");
    expect(container.querySelector<HTMLAnchorElement>('a[href$="/connections"]')?.href).toBe(
      `${serviceUrl}/connections`,
    );
    await click("Stop Check report");
    await click("Cancel");
    expect(requests).toEqual([]);
    await click("Stop Check report");
    await click("Confirm stop");
    expect(requests).toEqual([
      { path: "/handling/reminder/reminder1/stop", body: { expectedVersion: "opaque-v1" } },
    ]);
    expect(container.textContent).toContain("Reminder stopped.");
    expect(container.textContent).not.toContain("Check report");
  });

  it.each(["network", "http400", "http408"])(
    "retains a Run now ID after %s and gives a new click a new ID after acknowledgement",
    async (failure) => {
      state = withPanels();
      let attempts = 0;
      onPost = async (path) => {
        if (path.endsWith("/run")) {
          if (++attempts === 1) {
            if (failure === "network") throw new TypeError("Request interrupted");
            return Response.json(
              { ok: false, error: "Request interrupted" },
              { status: failure === "http400" ? 400 : 408 },
            );
          }
          return Response.json(
            {
              ok: true,
              runId: "routine1",
              threadId: "routine",
              status: "queued",
              duplicate: attempts === 2,
            },
            { status: 202 },
          );
        }
        return Response.json({ ok: true });
      };
      await render();
      await click("Run now");
      expect(container.textContent).toContain("Request interrupted");
      await click("Run now");
      expect(container.textContent).toContain("Run queued; it has not finished.");
      expect(container.textContent).not.toContain("Request interrupted");
      expect(container.textContent).toContain("Routine result");
      await click("Run now");
      const ids = requests
        .filter((request) => request.path.endsWith("/run"))
        .map((request) => request.body.requestId);
      expect(ids).toHaveLength(3);
      expect(ids[0]).toEqual(expect.any(String));
      expect(ids[1]).toBe(ids[0]);
      expect(ids[2]).not.toBe(ids[1]);
    },
  );

  it("refreshes a changed handling version on conflict without retrying Stop automatically", async () => {
    state = withPanels();
    onPost = async () => {
      state = {
        ...state,
        handling: {
          ...state.handling!,
          items: [{ ...state.handling!.items[0]!, version: "opaque-v2" }],
        },
      };
      return Response.json(
        { ok: false, stopped: false, outcome: "conflict", message: "This item changed." },
        { status: 409 },
      );
    };
    await render();
    await click("Stop Check report");
    await click("Confirm stop");
    expect(document.body.textContent).toContain("This item changed.");
    expect(button("Confirm stop").disabled).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("clears the owner session and private panels after an action returns 401", async () => {
    state = withPanels();
    onPost = async () => Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
    await render();
    await click("Run now");
    expect(sessionStorage.getItem(`dot-session:${serviceUrl}`)).toBeNull();
    expect(container.textContent).toContain("Connect to your TritonAI Bot");
    expect(container.querySelector("aside")).toBeNull();
    expect(container.textContent).not.toContain("Morning check");
  });

  it("acknowledges displayed Handling results through their generated timestamp", async () => {
    state = withPanels();
    state = {
      ...state,
      handling: {
        ...state.handling!,
        items: [{ ...state.handling!.items[0]!, state: "done-unseen", controls: [] }],
      },
    };
    onPost = async (path, body) => {
      if (path === "/handling/seen") {
        state = { ...state, handling: { ...state.handling!, items: [] } };
        return Response.json({ ok: true, seenAt: body.through });
      }
      return Response.json({ ok: true });
    };
    await render();
    expect(requests).toEqual([]);
    await click("Mark recent results seen");
    expect(requests).toEqual([{ path: "/handling/seen", body: { through: at } }]);
    expect(container.textContent).toContain("Recent results marked seen.");
    expect(container.textContent).not.toContain("Done (new)");
  });

  it("lets the owner mark routine results read without resuming a paused routine", async () => {
    state = {
      ...withPanels(),
      scheduledPrompts: [
        {
          ...prompt,
          enabled: false,
          pausedReason: "unread",
          consecutiveUnread: 5,
          lastRun: { at, runId: "last1", outcome: "notable" },
        },
      ],
    };
    onPost = async (path) => {
      if (path.endsWith("/opened")) {
        state = {
          ...state,
          scheduledPrompts: [{ ...state.scheduledPrompts![0]!, consecutiveUnread: 0 }],
        };
        return Response.json({ ok: true, prompt: state.scheduledPrompts![0] });
      }
      return Response.json({ ok: true });
    };
    await render();
    expect(requests).toEqual([]);
    await click("Mark results read");
    expect(requests).toEqual([{ path: `/scheduled-prompts/${prompt.promptId}/opened`, body: {} }]);
    expect(container.textContent).toContain(
      "Results marked read. A paused routine still needs Resume.",
    );
    expect(container.textContent).toContain("Resume");
    expect(container.textContent).not.toContain("5 unread results");
  });

  it("ignores a late feedback 401 after the owner disconnects and signs in again", async () => {
    // Keep the unrelated native hashing job inside the test's deterministic promise chain.
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    const newSession = { ...session, ownerToken: "replacement-owner-token" };
    state = {
      ...withPanels(),
      runs: [
        {
          runId: "brief",
          threadId: "dot",
          event: { kind: "routine" },
          status: "completed",
          createdAt: at,
          updatedAt: at,
          result: { summary: "Briefing output" },
        },
      ],
    };
    let finishRating!: (response: Response) => void;
    onPost = async (path) => {
      if (path.startsWith("/feedback/"))
        return new Promise<Response>((resolve) => {
          finishRating = resolve;
        });
      if (path === "/client/connect/start")
        return Response.json({
          ok: true,
          requestId: "connection1",
          expiresAt: session.expiresAt,
          verificationUrl: `${serviceUrl}/sign-in`,
          userCode: "SYNTHETIC",
        });
      if (path === "/client/connect/token") return Response.json({ ok: true, ...newSession });
      return Response.json({ ok: true });
    };
    await render();
    await click("👍 Useful");
    await click("Disconnect");
    await click("Sign in with UC San Diego");
    expect(JSON.parse(sessionStorage.getItem(`dot-session:${serviceUrl}`)!).ownerToken).toBe(
      newSession.ownerToken,
    );
    await act(async () =>
      finishRating(Response.json({ ok: false, error: "Old session expired." }, { status: 401 })),
    );
    expect(JSON.parse(sessionStorage.getItem(`dot-session:${serviceUrl}`)!).ownerToken).toBe(
      newSession.ownerToken,
    );
    expect(container.textContent).not.toContain("Old session expired.");
    expect(container.querySelector("aside")).not.toBeNull();
  });

  it("keeps a reopened workspace's new session when an unmounted workspace receives a late 401", async () => {
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    const newSession = { ...session, ownerToken: "reopened-owner-token" };
    state = {
      ...withPanels(),
      runs: [
        {
          runId: "brief",
          threadId: "dot",
          event: { kind: "routine" },
          status: "completed",
          createdAt: at,
          updatedAt: at,
          result: { summary: "Original output" },
        },
      ],
    };
    let finishRating!: (response: Response) => void;
    onPost = async (path) => {
      if (path.startsWith("/feedback/"))
        return new Promise<Response>((resolve) => {
          finishRating = resolve;
        });
      if (path === "/client/connect/start")
        return Response.json({
          ok: true,
          requestId: "reopened-connection",
          expiresAt: session.expiresAt,
          verificationUrl: `${serviceUrl}/sign-in`,
          userCode: "SYNTHETIC",
        });
      if (path === "/client/connect/token") return Response.json({ ok: true, ...newSession });
      return Response.json({ ok: true });
    };
    await render();
    await click("👍 Useful");
    await act(async () => root.render(null));
    await render();
    await click("Disconnect");
    await click("Sign in with UC San Diego");
    await act(async () =>
      finishRating(
        Response.json({ ok: false, error: "Unmounted owner expired." }, { status: 401 }),
      ),
    );
    expect(JSON.parse(sessionStorage.getItem(`dot-session:${serviceUrl}`)!).ownerToken).toBe(
      newSession.ownerToken,
    );
    expect(container.textContent).not.toContain("Unmounted owner expired.");
    expect(container.querySelector("aside")).not.toBeNull();
    await act(async () => root.render(null));
    await render();
    expect(container.textContent).not.toContain("Connect to your TritonAI Bot");
    expect(container.querySelector("aside")).not.toBeNull();
  });

  it("does not remove a replacement persisted session when the mounted workspace's old request fails", async () => {
    const newSession = { ...session, ownerToken: "other-workspace-owner-token" };
    state = {
      ...withPanels(),
      runs: [
        {
          runId: "brief",
          threadId: "dot",
          event: { kind: "routine" },
          status: "completed",
          createdAt: at,
          updatedAt: at,
          result: { summary: "Original output" },
        },
      ],
    };
    let finishRating!: (response: Response) => void;
    onPost = async (path) =>
      path.startsWith("/feedback/")
        ? new Promise<Response>((resolve) => {
            finishRating = resolve;
          })
        : Response.json({ ok: true });
    await render();
    await click("👍 Useful");
    saveDotSession(sessionStorage, serviceUrl, newSession);
    await act(async () =>
      finishRating(Response.json({ ok: false, error: "Old owner expired." }, { status: 401 })),
    );
    expect(JSON.parse(sessionStorage.getItem(`dot-session:${serviceUrl}`)!).ownerToken).toBe(
      newSession.ownerToken,
    );
  });

  it("sends the displayed controlVersion when pausing and uses the refreshed state", async () => {
    onPost = async (path) => {
      state = { ...state, user: { ...state.user, paused: path === "/pause", controlVersion: 4 } };
      return Response.json({ ok: true, paused: true, controlVersion: 4 });
    };
    await render();
    await click("Pause bot");
    expect(requests).toEqual([{ path: "/pause", body: { expectedControlVersion: 3 } }]);
    expect(container.textContent).toContain("Resume bot");
    expect(container.textContent).toContain("Work already running cannot be recalled.");
  });
});

async function fill(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  );
  if (!input) throw new Error(`Input missing: ${label}`);
  await act(async () => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function select(label: string, value: string) {
  const input = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submitForm(label: string) {
  const form = container.querySelector<HTMLFormElement>(`form[aria-label="${label}"]`)!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it("opens an inbox review at the existing approval and preserves the approve workflow", async () => {
  state = {
    ...withPanels(),
    enhancements: { decisionInbox: true },
    approvals: [
      {
        approvalId: "approval1",
        summary: "Prepare the report",
        action: "harness-task",
        payload: { title: "Report" },
      },
    ],
  };
  state = {
    ...state,
    handling: {
      ...state.handling!,
      items: [
        {
          kind: "approval",
          id: "approval1",
          title: "Prepare the report",
          state: "waiting-for-you",
          version: "approval:1",
          controls: ["review"],
          target: { kind: "approval", id: "approval1" },
        },
      ],
    },
  };
  onPost = async (path) => {
    if (path === "/approvals/approval1")
      state = { ...state, approvals: [], handling: { ...state.handling!, items: [] } };
    return Response.json({ ok: true });
  };
  await render();
  await click("Review Prepare the report");
  expect(document.activeElement?.id).toBe("bot-approval-approval1");
  expect(requests).toHaveLength(0);
  await click("Approve");
  expect(requests).toEqual([{ path: "/approvals/approval1", body: { approved: true } }]);
  expect(container.textContent).not.toContain("Prepare the report");
});

it("creates an editable recipe with schedule preview and retains one create ID after a lost acknowledgement", async () => {
  state = { ...withPanels(), enhancements: { routineEditor: true }, scheduledPrompts: [] };
  let attempts = 0;
  onPost = async (path, body) => {
    if (path === "/scheduled-prompts/preview")
      return Response.json({
        ok: true,
        scheduleText: "Weekdays at 09:00",
        nextRunAt: "2026-10-13T16:00:00Z",
      });
    if (path === "/scheduled-prompts") {
      if (++attempts === 1) throw new TypeError("Connection interrupted");
      state = {
        ...state,
        scheduledPrompts: [
          { ...prompt, version: 1, name: String(body.name), prompt: String(body.prompt) },
        ],
      };
      return Response.json({ ok: true, prompt: state.scheduledPrompts![0] });
    }
    return Response.json({ ok: true });
  };
  await render();
  await click("Create routine");
  await select("Recipe", "calendar");
  await fill("Recipe inputs", "Budget project");
  await fill("Routine timezone", "America/Los_Angeles");
  expect(container.textContent).toContain("Connection availability is not reported");
  await click("Preview schedule");
  expect(container.textContent).toContain("Weekdays at 09:00");
  await submitForm("Create routine");
  expect(container.textContent).toContain("Connection interrupted");
  await submitForm("Create routine");
  const creates = requests.filter((item) => item.path === "/scheduled-prompts");
  expect(creates).toHaveLength(2);
  expect(creates[0]!.body.requestId).toBe(creates[1]!.body.requestId);
  expect(creates[1]!.body).toMatchObject({
    name: "Meeting preparation",
    timezone: "America/Los_Angeles",
    notify: "if-notable",
    schedule: { kind: "weekdays", time: "09:00" },
  });
  expect(creates[1]!.body.prompt).toContain("Budget project");
  expect(creates[1]!.body.prompt).toContain("Expected output:");
  expect(container.querySelector('form[aria-label="Create routine"]')).toBeNull();
  expect(container.textContent).toContain("Edit routine");
});

it("requires reviewed memory wording, preserves its version, and does not mutate preferences on a rating", async () => {
  state = {
    ...snapshot(),
    enhancements: { memoryCorrection: true },
    dotMemory: [
      {
        memoryId: "memory1",
        version: 7,
        text: "Prefer weekly summaries",
        status: "active",
        kind: "preference",
        scope: "owner",
        provenance: { source: "owner", dataOnly: true, observations: [] },
      },
    ],
    feedback: [],
    runs: [
      {
        runId: "brief1",
        threadId: "dot",
        event: { kind: "routine" },
        status: "completed",
        createdAt: at,
        updatedAt: at,
        result: { summary: "Your briefing" },
      },
    ],
  };
  onPost = async (path, body) => {
    if (path === "/owner-memory" && body.action === "edit")
      state = {
        ...state,
        dotMemory: [{ ...state.dotMemory![0]!, version: 8, text: String(body.text) }],
      };
    if (path === "/feedback/brief1")
      state = {
        ...state,
        feedback: [{ outputId: "brief1", kind: "routine", rating: "not-useful" }],
      };
    return Response.json({ ok: true });
  };
  await render();
  await click("Edit memory");
  await fill("Memory text", "Prefer weekday summaries");
  expect(button("Save correction").disabled).toBe(true);
  await submitForm("Correct memory");
  expect(requests).toHaveLength(0);
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('form[aria-label="Correct memory"] input[type="checkbox"]')!
      .click(),
  );
  await submitForm("Correct memory");
  expect(requests[0]).toEqual({
    path: "/owner-memory",
    body: {
      action: "edit",
      memoryId: "memory1",
      expectedVersion: 7,
      text: "Prefer weekday summaries",
      kind: "preference",
      scope: "owner",
      reviewed: true,
    },
  });
  await click("👎 Not useful");
  expect(requests.filter((item) => item.path === "/owner-memory")).toHaveLength(1);
  await click("Save a preference…");
  await fill("Memory text", "Skip empty briefings");
  expect(button("Save preference").disabled).toBe(true);
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('form[aria-label="Save preference"] input[type="checkbox"]')!
      .click(),
  );
  await submitForm("Save preference");
  expect(requests.at(-1)).toEqual({
    path: "/owner-memory",
    body: {
      action: "save-preference",
      memoryId: expect.any(String),
      expectedVersion: 0,
      text: "Skip empty briefings",
      kind: "preference",
      scope: "owner",
      reviewed: true,
      sourceRunId: "brief1",
    },
  });
});

it("follows a task, shows evidence separately from completion, and versions snooze/resume", async () => {
  state = {
    ...snapshot(),
    enhancements: { responsibilities: true, resultCards: true },
    responsibilities: [],
    tasks: [
      {
        taskId: "task1",
        title: "Budget report",
        detail: { kind: "harness-task" },
        status: "completed",
        createdAt: at,
        updatedAt: at,
        result: "Report prepared",
        structuredResult: {
          version: 1,
          summary: "Report prepared",
          execution: { status: "completed", threadId: "thread1", messageId: "message1" },
          verification: { status: "unverified" },
          artifacts: [
            {
              label: "Budget source",
              uri: "https://example.test/budget",
              kind: "source",
              provenance: "assistant-reported",
            },
          ],
          checks: [
            { label: "Totals match", status: "reported-pass", provenance: "assistant-reported" },
          ],
          blockers: ["Owner must review"],
        },
      },
    ],
  };
  onPost = async (path, body) => {
    if (path === "/responsibilities") {
      if (body.action === "create" && (!body.responsibilityId || body.expectedVersion !== 0))
        return Response.json(
          { ok: false, error: "Create requires a stable ID and version zero" },
          { status: 400 },
        );
      if (body.action === "create")
        state = {
          ...state,
          responsibilities: [
            {
              responsibilityId: "resp1",
              version: 1,
              title: String(body.title),
              intendedOutcome: String(body.intendedOutcome),
              source: { kind: "harness-task", taskId: "task1" },
              completionCriteria: String(body.completionCriteria),
              nextAction: String(body.nextAction),
              allowedActions: ["observe-task", "notify-owner"],
              status: "active",
              linkedTaskIds: ["task1"],
              linkedRunIds: [],
              sourceEvidence: {
                taskId: "task1",
                updatedAt: at,
                status: "completed",
                digest: "evidence1",
                available: true,
              },
            },
          ],
        };
      else
        state = {
          ...state,
          responsibilities: [
            {
              ...state.responsibilities![0]!,
              version: state.responsibilities![0]!.version + 1,
              status: body.action === "snooze" ? "snoozed" : "active",
            },
          ],
        };
    }
    return Response.json({ ok: true });
  };
  await render();
  expect(container.textContent).toContain("Execution finished");
  expect(container.textContent).toContain("Not independently verified");
  expect(container.textContent).toContain("reported passed");
  await click("Follow a task");
  await fill("Intended outcome", "A reviewed budget report");
  await fill("Completion criteria", "Owner confirms totals and supporting sources");
  await submitForm("Responsibility editor");
  expect(requests[0]?.body).toMatchObject({
    action: "create",
    responsibilityId: expect.any(String),
    expectedVersion: 0,
  });
  expect(container.textContent).toContain("A reviewed budget report");
  await click("Review task");
  expect(container.querySelector<HTMLDetailsElement>("#bot-task-task1")!.open).toBe(true);
  await click("Snooze 1 hour");
  expect(requests.at(-1)?.body).toMatchObject({
    action: "snooze",
    responsibilityId: "resp1",
    expectedVersion: 1,
  });
  await click("Resume following");
  expect(requests.at(-1)?.body).toEqual({
    action: "resume",
    responsibilityId: "resp1",
    expectedVersion: 2,
  });
});

it("keeps selected files on a failed send and retries the same message before clearing them", async () => {
  state = { ...snapshot(), enhancements: { attachments: true } };
  vi.stubGlobal(
    "FileReader",
    class {
      result = "data:text/plain;base64,cmVwb3J0";
      load?: () => void;
      addEventListener(event: string, callback: () => void) {
        if (event === "load") this.load = callback;
      }
      readAsDataURL() {
        this.load?.();
      }
    },
  );
  let attempts = 0;
  onPost = async (path, body) => {
    if (path === "/attachments")
      return Response.json({
        ok: true,
        attachment: {
          attachmentId: "file1",
          name: body.name,
          mimeType: body.mimeType,
          size: 6,
          sha256: "synthetic",
          createdAt: at,
        },
      });
    if (path === "/message") {
      if (++attempts === 1) throw new TypeError("Send interrupted");
      return Response.json({ ok: true, runId: "message1", status: "queued" });
    }
    return Response.json({ ok: true });
  };
  await render();
  const input = container.querySelector<HTMLInputElement>(
    '[aria-label="Choose files for your bot"]',
  )!;
  await act(async () => {
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["report"], "report.txt", { type: "text/plain" })],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("Files ready to send");
  expect(container.textContent).toContain("report.txt");
  await fill("Message your bot", "Check this report");
  await click("Send message");
  expect(container.textContent).toContain("Send interrupted");
  expect(container.textContent).toContain("report.txt");
  await click("Send message");
  const sends = requests.filter((item) => item.path === "/message");
  expect(sends).toHaveLength(2);
  expect(sends[0]!.body).toEqual(sends[1]!.body);
  expect(sends[1]!.body).toMatchObject({ text: "Check this report", attachmentIds: ["file1"] });
  expect(requests.filter((item) => item.path === "/attachments")).toHaveLength(1);
  expect(container.textContent).not.toContain("report.txt");
});

it("preserves exact owner text when correcting only a memory type", async () => {
  const canonical = "Use https://example.invalid <b> and [reference](https://example.invalid)";
  state = {
    ...snapshot(),
    enhancements: { memoryCorrection: true },
    dotMemory: [
      {
        memoryId: "memory1",
        version: 1,
        text: "Use https∶//example.invalid ‹b›",
        status: "active",
        kind: "fact",
      },
    ],
  };
  const previousFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) =>
      new URL(String(input)).pathname === "/owner-memory/memory1"
        ? Promise.resolve(
            Response.json({ ok: true, memory: { ...state.dotMemory![0]!, text: canonical } }),
          )
        : previousFetch(input, init),
    ),
  );
  await render();
  await click("Edit memory");
  expect(
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory text"]')!.value,
  ).toBe(canonical);
  await act(async () => {
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Memory type"]')!;
    select.value = "preference";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    container
      .querySelector<HTMLInputElement>('form[aria-label="Correct memory"] input[type="checkbox"]')!
      .click();
  });
  await submitForm("Correct memory");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body).toMatchObject({
    action: "edit",
    expectedVersion: 1,
    text: canonical,
    kind: "preference",
    reviewed: true,
  });
});

it("does not overwrite a newer memory when a correction receives a version conflict", async () => {
  state = {
    ...snapshot(),
    enhancements: { memoryCorrection: true },
    dotMemory: [{ memoryId: "memory1", version: 1, text: "Original preference", status: "active" }],
  };
  onPost = async () => {
    state = {
      ...state,
      dotMemory: [{ ...state.dotMemory![0]!, version: 2, text: "Newer preference" }],
    };
    return Response.json({ ok: false, error: "This memory changed." }, { status: 409 });
  };
  await render();
  await click("Edit memory");
  await fill("Memory text", "My correction");
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('form[aria-label="Correct memory"] input[type="checkbox"]')!
      .click(),
  );
  await submitForm("Correct memory");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body.expectedVersion).toBe(1);
  expect(container.textContent).toContain("Newer preference");
  expect(container.textContent).toContain("Close this correction and review its latest version");
  expect(container.querySelector('form[aria-label="Correct memory"]')).toBeNull();
});

it("preserves interval days and its time window when editing a versioned routine", async () => {
  state = {
    ...withPanels(),
    enhancements: { routineEditor: true },
    scheduledPrompts: [
      {
        ...prompt,
        version: 4,
        schedule: {
          kind: "interval",
          everyMinutes: 60,
          days: ["mon", "wed"],
          window: { from: "08:00", to: "17:00" },
        },
      },
    ],
  };
  onPost = async () => Response.json({ ok: true, prompt: state.scheduledPrompts![0] });
  await render();
  await click("Edit routine");
  await fill("Routine name", "Updated check");
  await submitForm("Edit routine");
  expect(requests[0]).toMatchObject({
    path: `/scheduled-prompts/${prompt.promptId}/edit`,
    body: {
      expectedVersion: 4,
      name: "Updated check",
      schedule: {
        kind: "interval",
        everyMinutes: 60,
        days: ["mon", "wed"],
        window: { from: "08:00", to: "17:00" },
      },
    },
  });
});

it("explains the memory byte limit before sending a multi-byte correction", async () => {
  state = {
    ...snapshot(),
    enhancements: { memoryCorrection: true },
    dotMemory: [{ memoryId: "memory1", version: 1, text: "Original preference", status: "active" }],
  };
  await render();
  await click("Edit memory");
  await fill("Memory text", "語".repeat(700));
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('form[aria-label="Correct memory"] input[type="checkbox"]')!
      .click(),
  );
  expect(button("Save correction").disabled).toBe(true);
  expect(container.textContent).toContain("This memory is too long");
  await submitForm("Correct memory");
  expect(requests).toHaveLength(0);
});

it("loads an older followed task once, keeps it through state refresh, and allows reviewed completion", async () => {
  state = {
    ...snapshot(),
    enhancements: { responsibilities: true, resultCards: true },
    responsibilities: [
      {
        responsibilityId: "old-responsibility",
        version: 3,
        title: "Finish the archived report",
        intendedOutcome: "A reviewed report",
        source: { kind: "harness-task", taskId: "older-task" },
        completionCriteria: "Check the final totals",
        nextAction: "Review the returned report",
        allowedActions: ["observe-task", "notify-owner"],
        status: "needs-review",
        linkedTaskIds: ["older-task"],
        linkedRunIds: [],
        sourceEvidence: {
          taskId: "older-task",
          updatedAt: at,
          status: "completed",
          digest: "older-result-digest",
          available: true,
        },
      },
    ],
    tasks: Array.from({ length: 20 }, (_, index) => ({
      taskId: `recent${index}`,
      title: `Recent conversation ${index}`,
      status: "completed",
      createdAt: at,
      updatedAt: at,
    })),
  };
  const read = vi.fn(async () =>
    Response.json({
      ok: true,
      task: {
        taskId: "older-task",
        title: "Archived budget report",
        detail: { kind: "harness-task" },
        status: "completed",
        createdAt: at,
        updatedAt: at,
        result: "Final totals and sources are available for review.",
      },
    }),
  );
  onTaskRead = read;
  onPost = async (path, body) => {
    if (path === "/responsibilities" && body.action === "complete")
      state = {
        ...state,
        responsibilities: [{ ...state.responsibilities![0]!, version: 4, status: "completed" }],
      };
    return Response.json({ ok: true });
  };
  await render();
  expect(read).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Mark reviewed and complete");
  await click("Load task evidence");
  expect(read).toHaveBeenCalledExactlyOnceWith("older-task");
  expect(container.textContent).toContain("Final totals and sources are available for review.");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(read).toHaveBeenCalledTimes(1);
  await click("Review task");
  expect(container.querySelector<HTMLDetailsElement>("#bot-task-older-task")!.open).toBe(true);
  expect(button("Mark reviewed and complete").disabled).toBe(true);
  await act(async () =>
    container
      .querySelector<HTMLInputElement>(
        '#bot-responsibility-old-responsibility input[type="checkbox"]',
      )!
      .click(),
  );
  await click("Mark reviewed and complete");
  expect(requests.at(-1)).toEqual({
    path: "/responsibilities",
    body: {
      action: "complete",
      responsibilityId: "old-responsibility",
      expectedVersion: 3,
      reviewedEvidence: true,
      evidenceDigest: "older-result-digest",
    },
  });
  expect(container.textContent).toContain("Reviewed and completed");
});

it("keeps an unavailable older task unreviewed and offers an explicit retry", async () => {
  state = {
    ...snapshot(),
    enhancements: { responsibilities: true },
    responsibilities: [
      {
        responsibilityId: "missing-responsibility",
        version: 1,
        title: "Review an older task",
        intendedOutcome: "Reviewed outcome",
        source: { kind: "harness-task", taskId: "unavailable-task" },
        completionCriteria: "Review its result",
        nextAction: "Review the evidence",
        allowedActions: ["observe-task", "notify-owner"],
        status: "needs-review",
        linkedTaskIds: ["unavailable-task"],
        linkedRunIds: [],
        sourceEvidence: {
          taskId: "unavailable-task",
          updatedAt: at,
          status: "completed",
          digest: "result-digest",
          available: true,
        },
      },
    ],
  };
  await render();
  await click("Load task evidence");
  expect(container.textContent).toContain("Task unavailable");
  expect(container.textContent).not.toContain("Mark reviewed and complete");
  expect(button("Load task evidence").disabled).toBe(false);
  expect(requests).toHaveLength(0);
});

it("requires current completed evidence and a fresh review when a responsibility result changes", async () => {
  const freshAt = "2026-10-08T13:00:00Z";
  const laterAt = "2026-10-08T14:00:00Z";
  const task = {
    taskId: "mixed-task",
    title: "Budget report",
    detail: { kind: "harness-task" },
    status: "completed",
    createdAt: at,
    updatedAt: at,
    result: "Old totals",
  };
  state = {
    ...snapshot(),
    enhancements: { responsibilities: true },
    tasks: [task],
    responsibilities: [
      {
        responsibilityId: "mixed-responsibility",
        version: 2,
        title: "Review budget",
        intendedOutcome: "Reviewed budget",
        source: { kind: "harness-task", taskId: task.taskId },
        completionCriteria: "Confirm totals",
        nextAction: "Review the evidence",
        allowedActions: ["observe-task", "notify-owner"],
        status: "needs-review",
        linkedTaskIds: [task.taskId],
        linkedRunIds: [],
        sourceEvidence: {
          taskId: task.taskId,
          updatedAt: freshAt,
          status: "completed",
          digest: "fresh-digest",
          available: true,
        },
      },
    ],
  };
  onTaskRead = async () =>
    Response.json({ ok: true, task: { ...task, updatedAt: freshAt, result: "Corrected totals" } });
  await render();
  expect(container.textContent).toContain("The task evidence changed");
  expect(container.textContent).not.toContain("Mark reviewed and complete");
  await click("Load task evidence");
  expect(button("Mark reviewed and complete").disabled).toBe(true);
  await act(async () =>
    container
      .querySelector<HTMLInputElement>(
        '#bot-responsibility-mixed-responsibility input[type="checkbox"]',
      )!
      .click(),
  );
  expect(button("Mark reviewed and complete").disabled).toBe(false);
  state = {
    ...state,
    tasks: [{ ...task, updatedAt: freshAt, result: "Corrected totals" }],
    responsibilities: [
      {
        ...state.responsibilities![0]!,
        sourceEvidence: {
          ...state.responsibilities![0]!.sourceEvidence!,
          updatedAt: laterAt,
          digest: "later-digest",
        },
      },
    ],
  };
  onTaskRead = async () =>
    Response.json({
      ok: true,
      task: { ...task, updatedAt: laterAt, result: "Final corrected totals" },
    });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(container.textContent).not.toContain("Mark reviewed and complete");
  await click("Load task evidence");
  expect(button("Mark reviewed and complete").disabled).toBe(true);
  expect(container.textContent).toContain("Final corrected totals");
  expect(requests).toHaveLength(0);
});

it("does not offer resume for a cancelled responsibility", async () => {
  state = {
    ...snapshot(),
    enhancements: { responsibilities: true },
    responsibilities: [
      {
        responsibilityId: "cancelled-responsibility",
        version: 2,
        title: "Closed follow-up",
        intendedOutcome: "Reviewed outcome",
        source: { kind: "harness-task", taskId: "closed-task" },
        completionCriteria: "Review result",
        nextAction: "Cancelled by owner",
        allowedActions: ["observe-task", "notify-owner"],
        status: "cancelled",
        linkedTaskIds: ["closed-task"],
        linkedRunIds: [],
      },
    ],
  };
  await render();
  expect(container.textContent).toContain("Cancelled");
  expect(container.textContent).not.toContain("Resume following");
  expect(requests).toHaveLength(0);
});

it.each(["task", "approval"] as const)(
  "loads and opens an older inbox %s outside the recent snapshot",
  async (kind) => {
    state = {
      ...withPanels(),
      enhancements: { decisionInbox: true },
      handling: {
        ...withPanels().handling!,
        items: [
          {
            kind: kind === "task" ? "harness-assignment" : "approval",
            id: "older-item",
            title: "Older inbox item",
            state: kind === "task" ? "failed" : "waiting-for-you",
            version: kind === "task" ? at : "pending",
            controls: [kind === "task" ? "open" : "review"],
            target: { kind, id: "older-item" },
          },
        ],
      },
    };
    const read = vi.fn(async () =>
      Response.json(
        kind === "task"
          ? {
              ok: true,
              task: {
                taskId: "older-item",
                title: "Older task",
                detail: { kind: "harness-task" },
                status: "failed",
                createdAt: at,
                updatedAt: at,
                result: "Inspect older effects",
              },
            }
          : {
              ok: true,
              approval: {
                approvalId: "older-item",
                status: "pending",
                summary: "Older approval",
                action: "harness-task",
                payload: { title: "Exact proposed work" },
              },
            },
      ),
    );
    if (kind === "task") onTaskRead = read;
    else onApprovalRead = read;
    await render();
    await click(`${kind === "task" ? "Open" : "Review"} Older inbox item`);
    expect(read).toHaveBeenCalledExactlyOnceWith("older-item");
    expect(document.activeElement?.id).toBe(`bot-${kind}-older-item`);
    if (kind === "task")
      expect(container.querySelector<HTMLDetailsElement>("#bot-task-older-item")!.open).toBe(true);
    else expect(container.textContent).toContain("Older approval");
    expect(requests).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(container.querySelector(`#bot-${kind}-older-item`)).not.toBeNull();
    await click(`${kind === "task" ? "Open" : "Review"} Older inbox item`);
    expect(read).toHaveBeenCalledTimes(1);
    state = { ...state, handling: { ...state.handling!, items: [] } };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(container.querySelector(`#bot-${kind}-older-item`)).toBeNull();
  },
);

it.each(["task", "approval"] as const)(
  "discards an older inbox %s response after the owner reconnects",
  async (kind) => {
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    const newSession = { ...session, ownerToken: "replacement-inbox-owner-token" };
    state = {
      ...withPanels(),
      enhancements: { decisionInbox: true },
      handling: {
        ...withPanels().handling!,
        items: [
          {
            kind: kind === "task" ? "harness-assignment" : "approval",
            id: "private-item",
            title: "Private inbox item",
            state: "waiting-for-you",
            version: at,
            controls: ["open"],
            target: { kind, id: "private-item" },
          },
        ],
      },
    };
    let finish!: (response: Response) => void;
    const read = async () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    onPost = async (path) => {
      if (path === "/client/connect/start")
        return Response.json({
          ok: true,
          requestId: "inbox-connection",
          expiresAt: session.expiresAt,
          verificationUrl: `${serviceUrl}/sign-in`,
          userCode: "SYNTHETIC",
        });
      if (path === "/client/connect/token") return Response.json({ ok: true, ...newSession });
      return Response.json({ ok: true });
    };
    if (kind === "task") onTaskRead = read;
    else onApprovalRead = read;
    await render();
    await click("Open Private inbox item");
    await click("Disconnect");
    await click("Sign in with UC San Diego");
    await act(async () =>
      finish(
        Response.json(
          kind === "task"
            ? {
                ok: true,
                task: {
                  taskId: "private-item",
                  title: "Private task evidence",
                  detail: { kind: "harness-task" },
                  status: "completed",
                  createdAt: at,
                  updatedAt: at,
                  result: "Late private result",
                },
              }
            : {
                ok: true,
                approval: {
                  approvalId: "private-item",
                  status: "pending",
                  summary: "Late private approval",
                  action: "harness-task",
                  payload: {},
                },
              },
        ),
      ),
    );
    expect(container.textContent).not.toContain("Late private");
    expect(container.querySelector(`#bot-${kind}-private-item`)).toBeNull();
    expect(container.textContent).not.toContain("Your bot session changed");
    expect(JSON.parse(sessionStorage.getItem(`dot-session:${serviceUrl}`)!).ownerToken).toBe(
      newSession.ownerToken,
    );
  },
);

it("keeps an unavailable inbox target retryable and refuses resolved approvals", async () => {
  state = {
    ...withPanels(),
    enhancements: { decisionInbox: true },
    handling: {
      ...withPanels().handling!,
      items: [
        {
          kind: "approval",
          id: "old-approval",
          title: "Old approval",
          state: "waiting-for-you",
          version: "pending",
          controls: ["review"],
          target: { kind: "approval", id: "old-approval" },
        },
      ],
    },
  };
  await render();
  await click("Review Old approval");
  expect(container.textContent).toContain("Approval unavailable");
  expect(button("Review Old approval").disabled).toBe(false);
  onApprovalRead = async () =>
    Response.json({
      ok: true,
      approval: {
        approvalId: "old-approval",
        status: "denied",
        summary: "Resolved approval",
        action: "harness-task",
        payload: {},
      },
    });
  await click("Review Old approval");
  expect(container.textContent).toContain("This approval is no longer pending");
  expect(container.querySelector("#bot-approval-old-approval")).toBeNull();
  expect(requests).toHaveLength(0);
});
