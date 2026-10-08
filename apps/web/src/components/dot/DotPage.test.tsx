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
let requests: { path: string; body: Record<string, unknown> }[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state = snapshot();
  requests = [];
  onPost = async () => Response.json({ ok: true });
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

  it("retains a Run now ID on ambiguous failure and gives a new click a new ID after acknowledgement", async () => {
    state = withPanels();
    let attempts = 0;
    onPost = async (path) => {
      if (path.endsWith("/run")) {
        if (++attempts === 1) throw new TypeError("Network interrupted");
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
    expect(container.textContent).toContain("Network interrupted");
    await click("Run now");
    expect(container.textContent).toContain("Run queued; it has not finished.");
    expect(container.textContent).not.toContain("Network interrupted");
    expect(container.textContent).toContain("Routine result");
    await click("Run now");
    const ids = requests
      .filter((request) => request.path.endsWith("/run"))
      .map((request) => request.body.requestId);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toEqual(expect.any(String));
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[1]);
  });

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
