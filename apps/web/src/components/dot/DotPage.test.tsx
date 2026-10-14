// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const botView = vi.hoisted(() => ({ diagnostics: true }));
vi.mock("./botService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./botService")>()),
  useBotServiceUrl: () => "https://bot.example.test",
  useBotDiagnostics: () => botView.diagnostics,
}));
// Markdown rendering has its own tests; here a reply only needs its text.
vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div data-testid="bot-markdown">{text}</div>,
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: vi.fn() } }),
}));

import { DotPage } from "./DotPage";
import { saveDotSession, type DotState } from "./dotClient";
import type { DotResponsibility } from "./dotEnhancements";
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
  botView.diagnostics = true;
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
    await click("Useful");
    await click("Sign out of TritonAI Bot");
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
    await click("Useful");
    await act(async () => root.render(null));
    await render();
    await click("Sign out of TritonAI Bot");
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
    await click("Useful");
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
    expect(button("Resume bot").disabled).toBe(false);
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
  await click("Not useful");
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
    await click("Sign out of TritonAI Bot");
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

it.each(["snapshot", "401"] as const)(
  "ignores an older background %s after an action refresh succeeds",
  async (outcome) => {
    state = {
      ...withPanels(),
      tasks: [
        {
          taskId: "report",
          title: "Report",
          status: "completed",
          createdAt: at,
          updatedAt: at,
          result: "Older task result",
        },
      ],
    };
    const oldSnapshot = state;
    const previousFetch = globalThis.fetch;
    let reads = 0;
    let finishPoll!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        if (new URL(String(input)).pathname === "/state" && ++reads === 2)
          return new Promise<Response>((resolve) => {
            finishPoll = resolve;
          });
        return previousFetch(input, init);
      }),
    );
    onPost = async (path) => {
      if (path === "/pause")
        state = {
          ...state,
          user: { ...state.user, paused: true, controlVersion: 4 },
          tasks: [
            {
              ...state.tasks[0]!,
              result: "Updated task result",
              updatedAt: "2026-10-08T13:00:00Z",
            },
          ],
        };
      return Response.json({ ok: true });
    };
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    await click("Pause bot");
    expect(button("Resume bot").disabled).toBe(false);
    await act(async () =>
      finishPoll(
        outcome === "snapshot"
          ? Response.json({ ok: true, ...oldSnapshot })
          : Response.json({ ok: false, error: "Obsolete poll expired." }, { status: 401 }),
      ),
    );
    expect(container.textContent).toContain("Updated task result");
    expect(container.textContent).not.toContain("Older task result");
    expect(container.textContent).not.toContain("Obsolete poll expired.");
    expect(button("Resume bot").disabled).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(`dot-session:${serviceUrl}`)!).ownerToken).toBe(
      session.ownerToken,
    );
  },
);

it("waits for a slow background read and eventually applies it without overlapping polls", async () => {
  state = withPanels();
  const previousFetch = globalThis.fetch;
  let reads = 0;
  let finishPoll!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      if (new URL(String(input)).pathname === "/state" && ++reads === 2)
        return new Promise<Response>((resolve) => {
          finishPoll = resolve;
        });
      return previousFetch(input, init);
    }),
  );
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(reads).toBe(2);
  await act(async () =>
    finishPoll(
      Response.json({
        ok: true,
        ...state,
        user: { ...state.user, paused: true, controlVersion: 4 },
      }),
    ),
  );
  expect(button("Resume bot").disabled).toBe(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(reads).toBe(3);
});

it("keeps newly loaded task evidence when an older state read finishes later", async () => {
  state = {
    ...withPanels(),
    enhancements: { decisionInbox: true },
    handling: {
      ...withPanels().handling!,
      items: [
        {
          kind: "harness-assignment",
          id: "older-task",
          title: "Older report",
          state: "failed",
          version: at,
          controls: ["open"],
          target: { kind: "task", id: "older-task" },
        },
      ],
    },
  };
  const oldSnapshot = state;
  const previousFetch = globalThis.fetch;
  let reads = 0;
  let finishPoll!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) => {
      if (new URL(String(input)).pathname === "/state" && ++reads === 2)
        return new Promise<Response>((resolve) => {
          finishPoll = resolve;
        });
      return previousFetch(input, init);
    }),
  );
  const read = vi.fn(async () =>
    Response.json({
      ok: true,
      task: {
        taskId: "older-task",
        title: "Older report",
        status: "completed",
        createdAt: at,
        updatedAt: "2026-10-08T13:00:00Z",
        detail: { kind: "harness-task" },
        result: "Latest returned evidence",
      },
    }),
  );
  onTaskRead = read;
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  await click("Open Older report");
  await act(async () => finishPoll(Response.json({ ok: true, ...oldSnapshot })));
  expect(container.textContent).toContain("Latest returned evidence");
  expect(container.querySelector<HTMLDetailsElement>("#bot-task-older-task")!.open).toBe(true);
  await click("Open Older report");
  expect(read).toHaveBeenCalledTimes(1);
});

it("keeps the full long reply expandable alongside structured task evidence", async () => {
  const fullReply = `${"Detailed report paragraph.\n".repeat(300)}Final recommendation beyond the summary.`;
  state = {
    ...snapshot(),
    enhancements: { resultCards: true },
    tasks: [
      {
        taskId: "long-report",
        title: "Long report",
        status: "completed",
        createdAt: at,
        updatedAt: at,
        result: fullReply,
        structuredResult: {
          version: 1,
          summary: fullReply.slice(0, 4000),
          execution: {
            status: "completed",
            threadId: "report-thread",
            messageId: "report-message",
          },
          verification: { status: "unverified" },
          artifacts: [],
          checks: [],
          blockers: ["Review all recommendations"],
        },
      },
    ],
  };
  await render();
  const task = container.querySelector<HTMLDetailsElement>("#bot-task-long-report")!;
  await act(async () => task.querySelector("summary")!.click());
  const reply = [...task.querySelectorAll<HTMLDetailsElement>("details")].find(
    (details) => details.querySelector("summary")?.textContent === "Full task reply",
  )!;
  expect(reply.open).toBe(false);
  await act(async () => reply.querySelector("summary")!.click());
  expect(reply.open).toBe(true);
  expect(reply.querySelector("p")!.textContent).toBe(fullReply);
  expect(task.textContent).toContain("Final recommendation beyond the summary.");
  expect(task.textContent).toContain("Not independently verified");
  expect(task.textContent).toContain("Review all recommendations");
});

it("edits a canonical memory newer than the poll but still rejects a later version conflict", async () => {
  state = {
    ...snapshot(),
    enhancements: { memoryCorrection: true },
    dotMemory: [
      {
        memoryId: "memory1",
        version: 1,
        text: "Older list wording",
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
            Response.json({
              ok: true,
              memory: { ...state.dotMemory![0]!, version: 2, text: "Newest canonical wording" },
            }),
          )
        : previousFetch(input, init),
    ),
  );
  await render();
  await click("Edit memory");
  expect(
    container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Memory text"]')!.value,
  ).toBe("Newest canonical wording");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(container.querySelector('form[aria-label="Correct memory"]')).not.toBeNull();
  onPost = async () => {
    state = {
      ...state,
      dotMemory: [{ ...state.dotMemory![0]!, version: 3, text: "Concurrent owner correction" }],
    };
    return Response.json({ ok: false, error: "This memory changed." }, { status: 409 });
  };
  await fill("Memory text", "My reviewed correction");
  await act(async () =>
    container
      .querySelector<HTMLInputElement>('form[aria-label="Correct memory"] input[type="checkbox"]')!
      .click(),
  );
  await submitForm("Correct memory");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body.expectedVersion).toBe(2);
  expect(container.textContent).toContain("Concurrent owner correction");
  expect(container.textContent).toContain("Close this correction and review its latest version");
  expect(container.querySelector('form[aria-label="Correct memory"]')).toBeNull();
});

it("refuses a canonical memory response for another selected memory", async () => {
  state = {
    ...snapshot(),
    enhancements: { memoryCorrection: true },
    dotMemory: [{ memoryId: "memory1", version: 1, text: "Selected memory", status: "active" }],
  };
  const previousFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) =>
      new URL(String(input)).pathname === "/owner-memory/memory1"
        ? Promise.resolve(
            Response.json({ ok: true, memory: { ...state.dotMemory![0]!, memoryId: "memory2" } }),
          )
        : previousFetch(input, init),
    ),
  );
  await render();
  await click("Edit memory");
  expect(container.querySelector('form[aria-label="Correct memory"]')).toBeNull();
  expect(container.textContent).toContain(
    "The selected memory is no longer available for editing.",
  );
  expect(requests).toHaveLength(0);
});

it.each(["task", "approval"] as const)(
  "does not restore an older fetched %s over a newer action snapshot",
  async (kind) => {
    state = {
      ...withPanels(),
      enhancements: { decisionInbox: true },
      handling: {
        ...withPanels().handling!,
        items: [
          {
            kind: kind === "task" ? "harness-assignment" : "approval",
            id: "pending-read",
            title: "Pending read",
            state: "waiting-for-you",
            version: at,
            controls: ["open"],
            target: { kind, id: "pending-read" },
          },
        ],
      },
    };
    let finishRead!: (response: Response) => void;
    const read = async () =>
      new Promise<Response>((resolve) => {
        finishRead = resolve;
      });
    if (kind === "task") onTaskRead = read;
    else onApprovalRead = read;
    onPost = async (path) => {
      if (path === "/pause")
        state = {
          ...state,
          user: { ...state.user, paused: true, controlVersion: 4 },
          handling: { ...state.handling!, items: [] },
          tasks:
            kind === "task"
              ? [
                  {
                    taskId: "pending-read",
                    title: "Current report",
                    status: "completed",
                    createdAt: at,
                    updatedAt: "2026-10-08T13:00:00Z",
                    detail: { kind: "harness-task" },
                    result: "Current task evidence",
                  },
                ]
              : [],
        };
      return Response.json({ ok: true });
    };
    await render();
    await click("Open Pending read");
    await click("Pause bot");
    await act(async () =>
      finishRead(
        Response.json(
          kind === "task"
            ? {
                ok: true,
                task: {
                  taskId: "pending-read",
                  title: "Old report",
                  status: "completed",
                  createdAt: at,
                  updatedAt: at,
                  detail: { kind: "harness-task" },
                  result: "Obsolete task evidence",
                },
              }
            : {
                ok: true,
                approval: {
                  approvalId: "pending-read",
                  status: "pending",
                  summary: "Obsolete approval",
                  action: "harness-task",
                  payload: {},
                },
              },
        ),
      ),
    );
    expect(container.textContent).not.toContain("Obsolete");
    if (kind === "task") expect(container.textContent).toContain("Current task evidence");
    else expect(container.querySelector("#bot-approval-pending-read")).toBeNull();
    expect(button("Resume bot").disabled).toBe(false);
  },
);

it("continues a responsibility from an explicit reply, resolves a held message and keeps waiting state reversible", async () => {
  const responsibility = (id: string, title: string, version: number) => ({
    responsibilityId: id,
    version,
    title,
    intendedOutcome: "Reviewed",
    source: { kind: "harness-task" as const, taskId: `${id}-task` },
    completionCriteria: "Checked",
    nextAction: "Observe",
    allowedActions: ["observe-task" as const, "notify-owner" as const],
    status: "active" as const,
    linkedTaskIds: [`${id}-task`],
    linkedRunIds: [],
  });
  const replies = {
    enabled: true,
    lastSeq: 1,
    requirementVersion: 1,
    awaiting: { input: "the signed spreadsheet", since: at },
    log: [
      {
        seq: 1,
        runId: "earlier",
        sourceId: "harness:earlier",
        channel: "harness" as const,
        receivedAt: at,
        intent: "requirement" as const,
        reason: "You revised the deadline.",
        association: "matched" as const,
        handledByRunId: "earlier",
        handledAt: at,
      },
    ],
    revisions: [
      { seq: 1, runId: "earlier", at, kind: "deadline" as const, text: "Due Friday instead" },
    ],
  };
  state = {
    ...snapshot(),
    enhancements: { responsibilities: true, replyContinuation: true },
    responsibilities: [
      { ...responsibility("budget", "Budget review", 4), replies },
      responsibility("vendor", "Vendor summary", 2),
    ],
    runs: [
      {
        runId: "held1",
        threadId: "dot",
        event: { kind: "message", text: "Here are both signed files" },
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        result: {
          summary: "I didn't change anything",
          detail: {
            replyHeld: {
              sourceId: "harness:held1",
              intent: "input",
              classification: "You supplied information or a link.",
              reason: "It could belong to 2 waiting responsibilities, so none was changed.",
              candidates: [
                { responsibilityId: "budget", title: "Budget review" },
                { responsibilityId: "vendor", title: "Vendor summary" },
              ],
            },
          },
        },
      },
    ],
  };
  onPost = async (path) =>
    path === "/message"
      ? Response.json({
          ok: true,
          runId: "reply1",
          status: "queued",
          reply: {
            outcome: "continued",
            reason: "You supplied information or a link.",
            responsibilityId: "budget",
            title: "Budget review",
            intent: "input",
          },
        })
      : Response.json({ ok: true });
  await render();
  expect(container.textContent).toContain("Waiting for your reply: the signed spreadsheet");
  expect(container.textContent).toContain("Deadline");
  expect(container.textContent).toContain("Due Friday instead");
  expect(container.textContent).toContain("Changed a requirement");

  await click("Reply in chat");
  expect(container.textContent).toContain("Replying to “Budget review”");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Message your bot");
  expect(
    document.getElementById(document.activeElement!.getAttribute("aria-describedby")!)?.textContent,
  ).toContain("Replying to “Budget review”");
  await fill("Message your bot", "Here is the signed spreadsheet link");
  await click("Send message");
  expect(requests.find((item) => item.path === "/message")?.body).toMatchObject({
    text: "Here is the signed spreadsheet link",
    responsibilityId: "budget",
  });
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Continuing “Budget review”",
  );
  expect(container.textContent).not.toContain("Replying to “Budget review”");

  await click("Stop waiting");
  expect(requests.at(-1)).toEqual({
    path: "/responsibilities",
    body: { action: "stop-waiting", responsibilityId: "budget", expectedVersion: 4 },
  });
  // The vendor row has replies off, so only the budget row offers the held message.
  expect(
    [...document.querySelectorAll("button")].filter(
      (node) => node.textContent?.trim() === "Use that message here",
    ),
  ).toHaveLength(1);
  await click("Use that message here");
  expect(requests.at(-1)?.body).toEqual({
    action: "use-reply",
    responsibilityId: "budget",
    expectedVersion: 4,
    runId: "held1",
  });
  await fill("Input to wait for", "the vendor contract");
  await submitForm("Wait for a reply for Vendor summary");
  expect(requests.at(-1)?.body).toEqual({
    action: "wait",
    responsibilityId: "vendor",
    expectedVersion: 2,
    input: "the vendor contract",
  });
  await click("Continue from my replies");
  expect(requests.at(-1)?.body).toEqual({
    action: "replies",
    responsibilityId: "vendor",
    expectedVersion: 2,
    enabled: true,
  });
});

it("never sends a reply target to a service without reply continuation", async () => {
  state = {
    ...snapshot(),
    enhancements: { responsibilities: true },
    responsibilities: [
      {
        responsibilityId: "budget",
        version: 1,
        title: "Budget review",
        intendedOutcome: "Reviewed",
        source: { kind: "harness-task", taskId: "task" },
        completionCriteria: "Checked",
        nextAction: "Observe",
        allowedActions: ["observe-task", "notify-owner"],
        status: "cancelled",
        linkedTaskIds: ["task"],
        linkedRunIds: [],
      },
    ],
  };
  onPost = async () => Response.json({ ok: true, runId: "chat1", status: "queued" });
  await render();
  expect(() => button("Reply in chat")).toThrow();
  expect(() => button("Reopen following")).toThrow();
  await fill("Message your bot", "Here is the budget");
  await click("Send message");
  expect(requests.find((item) => item.path === "/message")?.body).not.toHaveProperty(
    "responsibilityId",
  );
});

it("keeps a rejected reply's draft and target, explains why beside the composer, and still sends ordinary chat", async () => {
  state = {
    ...snapshot(),
    enhancements: { responsibilities: true, replyContinuation: true },
    responsibilities: [
      {
        responsibilityId: "budget",
        version: 3,
        title: "Budget review",
        intendedOutcome: "Reviewed",
        source: { kind: "harness-task", taskId: "task" },
        completionCriteria: "Checked",
        nextAction: "Observe",
        allowedActions: ["observe-task", "notify-owner"],
        status: "active",
        linkedTaskIds: ["task"],
        linkedRunIds: [],
        replies: {
          enabled: true,
          lastSeq: 0,
          requirementVersion: 0,
          epoch: 1,
          log: [],
          revisions: [],
        },
      },
    ],
  };
  onPost = async (path, body) =>
    path === "/message" && body.responsibilityId
      ? Response.json(
          {
            ok: false,
            error:
              "“Budget review” is snoozed. Resume it first. Nothing was sent. Send it without choosing a responsibility for an ordinary answer.",
          },
          { status: 409 },
        )
      : Response.json({ ok: true, runId: "chat1", status: "queued" });
  await render();
  await click("Reply in chat");
  await fill("Message your bot", "Here is the signed spreadsheet");
  await click("Send message");
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Not sent: “Budget review” is snoozed.",
  );
  expect(container.querySelector<HTMLInputElement>('[aria-label="Message your bot"]')?.value).toBe(
    "Here is the signed spreadsheet",
  );
  expect(container.textContent).toContain("Replying to “Budget review”");
  await click("Send as ordinary chat");
  await click("Send message");
  const sent = requests.filter((item) => item.path === "/message");
  expect(sent).toHaveLength(2);
  expect(sent[0]?.body).toMatchObject({ responsibilityId: "budget" });
  expect(sent[1]?.body).not.toHaveProperty("responsibilityId");
  expect(sent[1]?.body.requestId).not.toBe(sent[0]?.body.requestId);
});

it("offers only Deny for an assignment approval that can no longer start", async () => {
  state = {
    ...snapshot(),
    approvals: [
      {
        approvalId: "stale1",
        summary: "Harness task: Old budget brief",
        action: "harness-task",
        payload: { title: "Old budget brief", responsibilityId: "budget" },
        notStartable: "“Budget review” was cancelled.",
      },
    ],
  };
  onPost = async () => Response.json({ ok: true });
  await render();
  expect(container.textContent).toContain(
    "Can't start: “Budget review” was cancelled. Approving won't run it",
  );
  expect(() => button("Approve")).toThrow();
  await click("Deny");
  expect(requests).toEqual([{ path: "/approvals/stale1", body: { approved: false } }]);
});

describe("waiting reasons", () => {
  const minutes = (count: number) => new Date(Date.parse(at) + count * 60_000).toISOString();
  function followed(overrides: Partial<DotResponsibility> = {}): DotResponsibility {
    return {
      responsibilityId: "budget",
      version: 3,
      title: "Quarterly budget review",
      intendedOutcome: "A reviewed budget summary",
      source: { kind: "harness-task", taskId: "budget-task" },
      completionCriteria: "Totals match the signed spreadsheet.",
      nextAction: "Observe this task and bring back its result for review.",
      allowedActions: ["observe-task", "notify-owner"],
      status: "active",
      linkedTaskIds: ["budget-task"],
      linkedRunIds: [],
      ...overrides,
    };
  }
  const claimedText =
    "The selected task was claimed by your task computer. No result has come back yet.";
  const offlineText =
    "The selected task is queued. Synthetic Mac is offline, so it waits until that computer checks in.";
  function withFollowed(responsibility: DotResponsibility): DotState {
    return {
      ...withPanels(),
      enhancements: { responsibilities: true, replyContinuation: true, waitingReasons: true },
      responsibilities: [responsibility],
    };
  }

  it("explains why a followed task waits and resumes a paused bot from its recovery", async () => {
    state = {
      ...withFollowed(
        followed({
          waiting: {
            code: "bot-paused",
            on: "you",
            text: "Your bot is paused, so this isn't checked and your replies don't continue it until you resume.",
            action: { kind: "resume-bot", label: "Resume your bot" },
            confirmed: { at, what: "Last change" },
            next: [{ kind: "event", what: "Checks resume when you resume your bot" }],
          },
        }),
      ),
      user: { ...snapshot().user, paused: true, controlVersion: 7 },
    };
    await render();
    const status = container.querySelector('[aria-label="Status of Quarterly budget review"]')!;
    expect(status.textContent).toContain("Waiting on you");
    expect(status.textContent).toContain("Next: Checks resume when you resume your bot");
    expect(status.textContent).not.toContain("Next check:");
    await click("Resume your bot");
    expect(requests).toContainEqual({ path: "/resume", body: { expectedControlVersion: 7 } });
  });

  it("labels a reply whose continuation stopped partway with its real outcome, not as continued", async () => {
    state = withFollowed(
      followed({
        replies: {
          enabled: true,
          lastSeq: 1,
          requirementVersion: 1,
          revisions: [],
          log: [
            {
              seq: 1,
              runId: "reply-run",
              sourceId: "harness:first",
              channel: "harness",
              receivedAt: at,
              intent: "input",
              reason: "You supplied information or a link.",
              association: "explicit",
              handledByRunId: "reply-run",
              handledAt: at,
              continuation: { status: "halted", at, reason: "You changed the deadline." },
              outcome: {
                code: "halted",
                text: "Continued, then stopped: You changed the deadline. Steps it took before stopping still stand.",
              },
            },
          ],
        },
      }),
    );
    await render();
    const replies = container.querySelector('[aria-label="Replies for Quarterly budget review"]')!;
    expect(replies.textContent).toContain("Continued, then stopped: You changed the deadline.");
    expect(replies.textContent).not.toMatch(/·\s*Continued(?!,)/);
  });

  it("opens a file's assignment outside the newest tasks through the scoped route and keeps its result", async () => {
    state = {
      ...withPanels(),
      enhancements: { fileRecipes: true, waitingReasons: true },
      fileRecipes: [
        {
          recipeId: "fr_0123456789ab",
          name: "Inbox summaries",
          instructions: "Summarize each new report.",
          expectedOutput: "A short summary.",
          approval: "ask",
          folder: { folderId: "folder-inbox", name: "Inbox", webUrl: "" },
          status: "active",
          generation: 1,
          version: 4,
          cadence: "about every 5 minutes",
          events: [
            {
              key: "0123456789abcdef01234567",
              version: {
                itemId: "item-1",
                name: "q3-report.md",
                cTag: "c1",
                size: 12,
                lastModifiedDateTime: at,
                webUrl: "",
              },
              status: "assigned",
              seenAt: at,
              updatedAt: at,
              taskId: "old-task",
              current: true,
              startable: false,
              waiting: {
                code: "not-in-snapshot",
                on: "unknown",
                text: "This file's assignment is no longer active. Open it to see its result.",
                action: {
                  kind: "open",
                  label: "Open the assignment",
                  target: { kind: "task", id: "old-task" },
                },
                next: [{ kind: "none", what: "Its assignment has its own status." }],
              },
            },
          ],
          createdAt: at,
          updatedAt: at,
        },
      ],
    };
    const read = vi.fn(async () =>
      Response.json({
        ok: true,
        task: {
          taskId: "old-task",
          title: "Inbox summaries: q3-report.md",
          status: "completed",
          createdAt: at,
          updatedAt: at,
          detail: { kind: "harness-task" },
          result: "Summary written next to the source.",
        },
      }),
    );
    onTaskRead = read;
    await render();
    expect(container.textContent).not.toContain("Summary written next to the source.");
    await click("Open the assignment");
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLDetailsElement>("#bot-task-old-task")!.open).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(container.textContent).toContain("Summary written next to the source.");
  });

  it("checks a reply whose outcome the service couldn't confirm by loading its run into the conversation and keeping it", async () => {
    state = withFollowed(
      followed({
        replies: {
          enabled: true,
          lastSeq: 1,
          requirementVersion: 0,
          revisions: [],
          log: [
            {
              seq: 1,
              runId: "old-reply-run",
              sourceId: "harness:old",
              channel: "harness",
              receivedAt: at,
              intent: "input",
              reason: "You supplied information or a link.",
              association: "explicit",
              handledByRunId: "old-reply-run",
              handledAt: at,
              outcome: {
                code: "unconfirmed",
                text: "Taken to continue this. How the continuation ended isn't in this view; check how it ended before relying on it.",
                action: {
                  kind: "open",
                  label: "Check how it ended",
                  target: { kind: "run", id: "old-reply-run" },
                },
              },
            },
          ],
        },
      }),
    );
    const base = globalThis.fetch;
    const read = vi.fn(async () =>
      Response.json({
        ok: true,
        run: {
          runId: "old-reply-run",
          threadId: "dot",
          event: { kind: "message", text: "Here is the budget spreadsheet" },
          status: "failed",
          createdAt: at,
          updatedAt: at,
          error: "The continuation failed before finishing.",
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) =>
        new URL(String(input)).pathname === "/runs/old-reply-run" ? read() : base(input, init),
      ),
    );
    await render();
    const replies = container.querySelector('[aria-label="Replies for Quarterly budget review"]')!;
    // Only the take is known: it is never shown as continued.
    expect(replies.textContent).toContain("How the continuation ended isn't in this view");
    expect(replies.textContent).not.toMatch(/·\s*Continued/);
    expect(container.querySelector("#bot-run-old-reply-run")).toBeNull();
    await click("Check how it ended");
    expect(read).toHaveBeenCalledTimes(1);
    // The run's own record answers in the conversation, where it is opened.
    expect(container.querySelector("#bot-run-old-reply-run")).not.toBeNull();
    expect(container.textContent).toContain("The continuation failed before finishing.");
    expect(document.activeElement?.id).toBe("bot-run-old-reply-run");
    // A refresh whose newest page doesn't include it keeps it in view.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(container.textContent).toContain("The continuation failed before finishing.");
    await click("Check how it ended");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("never replaces a newer responsibility it already showed with an older copy from a later read", async () => {
    const claimed = followed({
      version: 5,
      waiting: {
        code: "claimed",
        on: "computer",
        text: claimedText,
        next: [{ kind: "event", what: "Its result returns here" }],
      },
    });
    const older = followed({
      version: 4,
      waiting: {
        code: "computer-offline",
        on: "computer",
        text: offlineText,
        next: [{ kind: "event", what: "Starts when picked up" }],
      },
    });
    state = withFollowed(claimed);
    await render();
    expect(container.textContent).toContain(claimedText);
    state = withFollowed(older);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(container.textContent).toContain(claimedText);
    expect(container.textContent).not.toContain(offlineText);
    state = withFollowed({ ...older, version: 6 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(container.textContent).toContain(offlineText);
  });

  it("drops a late read for the previous owner after switching owners", async () => {
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    const newSession = { ...session, ownerToken: "replacement-owner-token" };
    state = withFollowed(
      followed({
        waiting: {
          code: "claimed",
          on: "computer",
          text: claimedText,
          next: [{ kind: "event", what: "x" }],
        },
      }),
    );
    const previousFetch = globalThis.fetch;
    let reads = 0;
    let finishPoll!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        if (new URL(String(input)).pathname === "/state" && ++reads === 2)
          return new Promise<Response>((resolve) => {
            finishPoll = resolve;
          });
        return previousFetch(input, init);
      }),
    );
    onPost = async (path) => {
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    const previousOwner = state;
    await click("Sign out of TritonAI Bot");
    state = withFollowed(
      followed({
        responsibilityId: "other",
        title: "Vendor summary",
        waiting: {
          code: "computer-none",
          on: "you",
          text: "No computer is set to run Harness tasks.",
          next: [{ kind: "event", what: "x" }],
        },
      }),
    );
    await click("Sign in with UC San Diego");
    await act(async () => finishPoll(Response.json({ ok: true, ...previousOwner })));
    expect(container.textContent).toContain("No computer is set to run Harness tasks.");
    expect(container.textContent).not.toContain(claimedText);
  });

  it("keeps the last status while disconnected and says when its own change time has passed", async () => {
    state = withFollowed(
      followed({
        waiting: {
          code: "claimed",
          on: "computer",
          text: claimedText,
          next: [{ kind: "event", what: "Its result returns here" }],
          changesAt: minutes(3),
        },
      }),
    );
    vi.setSystemTime(Date.parse(at));
    const previousFetch = globalThis.fetch;
    let offline = false;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) =>
        offline && new URL(String(input)).pathname === "/state"
          ? Promise.reject(new TypeError("Failed to fetch"))
          : previousFetch(input, init),
      ),
    );
    await render();
    offline = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(container.textContent).toContain(
      "Connection interrupted. These are the last received updates.",
    );
    expect(container.textContent).toContain(claimedText);
    expect(container.textContent).not.toContain("This was expected to change at");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(container.textContent).toContain("This was expected to change at");
  });
});

describe("chat-only view", () => {
  beforeEach(() => {
    botView.diagnostics = false;
  });

  function fullState(): DotState {
    return {
      ...withPanels(),
      enhancements: { decisionInbox: true, memoryCorrection: true },
      dotMemory: [
        {
          memoryId: "memory1",
          version: 1,
          text: "Prefer weekly summaries",
          status: "active",
          kind: "preference",
          scope: "owner",
          provenance: { source: "owner", dataOnly: true, observations: [] },
        },
      ],
      quality: { windows: [] } as unknown as NonNullable<DotState["quality"]>,
      tasks: [
        {
          taskId: "task1",
          title: "Message via teams",
          status: "completed",
          createdAt: at,
          updatedAt: at,
        },
      ],
      runs: [
        {
          runId: "chat1",
          threadId: "dot",
          event: { kind: "message", text: "what about today" },
          status: "completed",
          createdAt: at,
          updatedAt: at,
          result: { summary: "**Still ahead:** Pickup at 2:00 PM" },
        },
      ],
      approvals: [
        {
          approvalId: "approval1",
          summary: "Draft a reply to Jane",
          action: "harness-task",
          payload: { title: "Reply" },
        },
      ],
    };
  }

  it("shows only the conversation, with replies as markdown and approvals inline", async () => {
    state = fullState();
    onPost = async (path) => {
      if (path === "/approvals/approval1") state = { ...state, approvals: [] };
      return Response.json({ ok: true });
    };
    await render();
    expect(container.querySelector("aside")).toBeNull();
    expect(container.textContent).not.toContain("Message via teams");
    expect(container.textContent).not.toContain("Prefer weekly summaries");
    expect(container.textContent).toContain("what about today");
    expect(container.querySelector('[data-testid="bot-markdown"]')?.textContent).toBe(
      "**Still ahead:** Pickup at 2:00 PM",
    );
    expect(container.textContent).toContain("Draft a reply to Jane");
    await click("Approve");
    expect(requests).toEqual([{ path: "/approvals/approval1", body: { approved: true } }]);
    expect(container.textContent).not.toContain("Draft a reply to Jane");
  });

  it("brings the records back beside the chat with the developer setting", async () => {
    botView.diagnostics = true;
    state = fullState();
    await render();
    expect(container.querySelector("aside")).not.toBeNull();
    expect(container.textContent).toContain("Message via teams");
    expect(container.textContent).toContain("Prefer weekly summaries");
  });

  it("sends on Enter and keeps Shift+Enter for a new line", async () => {
    onPost = async (path) =>
      path === "/message"
        ? Response.json({ ok: true, runId: "message1", status: "queued" })
        : Response.json({ ok: true });
    await render();
    await fill("Message your bot", "first line");
    const composer = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message your bot"]',
    )!;
    await act(async () => {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
      );
    });
    expect(requests).toHaveLength(0);
    await act(async () => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(requests.map((item) => [item.path, item.body.text])).toEqual([
      ["/message", "first line"],
    ]);
  });

  it("resumes from the paused notice and keeps pause in the header", async () => {
    state = { ...snapshot(), user: { ...snapshot().user, paused: true } };
    onPost = async (path) => {
      state = { ...state, user: { ...state.user, paused: path === "/pause", controlVersion: 4 } };
      return Response.json({ ok: true, paused: path === "/pause", controlVersion: 4 });
    };
    await render();
    expect(container.textContent).toContain("Your bot is paused.");
    await click("Resume");
    expect(requests).toEqual([{ path: "/resume", body: { expectedControlVersion: 3 } }]);
    expect(container.textContent).not.toContain("Your bot is paused.");
    expect(button("Pause bot").disabled).toBe(false);
  });
});
