import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { trackThreadReadState } from "./threadReadState";
import { markThreadVisited, type UiState } from "./uiStateStore";

const createdAt = "2026-09-10T10:00:00.000Z";
const startedAt = "2026-09-10T10:01:00.000Z";
const completedAt = "2026-09-10T10:02:00.000Z";
const threadKey = "environment-a:thread-1";

let documentTarget: EventTarget & { visibilityState: string; hasFocus: () => boolean };
let windowTarget: EventTarget;
let focused: boolean;
let state: UiState;
let stop: (() => void) | undefined;

function track(overrides: Partial<Parameters<typeof trackThreadReadState>[0]> = {}) {
  stop?.();
  stop = trackThreadReadState({
    threadKey,
    createdAt,
    startedAt: null,
    completedAt: null,
    markVisited: (key, visitedAt) => {
      state = markThreadVisited(state, key, visitedAt);
    },
    ...overrides,
  });
}

beforeEach(() => {
  focused = true;
  documentTarget = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => focused,
  });
  windowTarget = new EventTarget();
  vi.stubGlobal("document", documentTarget);
  vi.stubGlobal("window", windowTarget);
  state = {
    projectExpandedById: {},
    projectOrder: [],
    pinnedProjectOrder: [],
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    defaultAdvertisedEndpointKey: null,
  };
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
});

describe("thread read tracking", () => {
  it("establishes a visit before the first response without marking historical threads", () => {
    track();
    expect(state.threadLastVisitedAtById).toEqual({ [threadKey]: createdAt });
    track({ startedAt });
    expect(state.threadLastVisitedAtById[threadKey]).toBe(startedAt);
  });

  it("keeps a first completion unread after navigating to another chat", () => {
    track({ startedAt });
    track({ threadKey: "environment-a:thread-2", completedAt });
    windowTarget.dispatchEvent(new Event("focus"));
    expect(state.threadLastVisitedAtById[threadKey]).toBe(startedAt);
    expect(Date.parse(completedAt)).toBeGreaterThan(
      Date.parse(state.threadLastVisitedAtById[threadKey]!),
    );
  });

  it("keeps a background-tab completion unread until the chat is visible and focused", () => {
    track({ startedAt });
    documentTarget.visibilityState = "hidden";
    focused = false;
    track({ startedAt, completedAt });
    windowTarget.dispatchEvent(new Event("focus"));
    expect(state.threadLastVisitedAtById[threadKey]).toBe(startedAt);
    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(state.threadLastVisitedAtById[threadKey]).toBe(startedAt);
    focused = true;
    windowTarget.dispatchEvent(new Event("focus"));
    expect(state.threadLastVisitedAtById[threadKey]).toBe(completedAt);
  });

  it("does not acknowledge a completion in an unfocused desktop window", () => {
    track({ startedAt });
    focused = false;
    track({ startedAt, completedAt });
    expect(state.threadLastVisitedAtById[threadKey]).toBe(startedAt);
    focused = true;
    windowTarget.dispatchEvent(new Event("focus"));
    expect(state.threadLastVisitedAtById[threadKey]).toBe(completedAt);
  });

  it("acknowledges foreground completions using server time even if the client clock is ahead", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T00:00:00Z"));
    track({ startedAt, completedAt });
    expect(state.threadLastVisitedAtById[threadKey]).toBe(completedAt);
    vi.restoreAllMocks();
  });

  it("does not clear later wake markers or move an existing visit backwards", () => {
    const wokeAt = "2026-09-10T10:03:00.000Z";
    track({ startedAt, completedAt });
    expect(Date.parse(state.threadLastVisitedAtById[threadKey]!)).toBeLessThan(Date.parse(wokeAt));
    state = markThreadVisited(state, threadKey, wokeAt);
    windowTarget.dispatchEvent(new Event("focus"));
    expect(state.threadLastVisitedAtById[threadKey]).toBe(wokeAt);
  });

  it("stops acknowledging the old chat when it unmounts", () => {
    focused = false;
    track({ completedAt });
    stop?.();
    focused = true;
    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(state.threadLastVisitedAtById).toEqual({});
  });
});
