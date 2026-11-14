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
    sidebarProjectScopeKey: null,
    pullRequestMergeMethod: "squash",
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
  // regression: #211 fix(web): distinguish active chats and preserve unread replies
  it("keeps a first completion unread after navigating to another chat", () => {
    track({ startedAt });
    track({ threadKey: "environment-a:thread-2", completedAt });
    windowTarget.dispatchEvent(new Event("focus"));
    expect(state.threadLastVisitedAtById[threadKey]).toBe(startedAt);
    expect(Date.parse(completedAt)).toBeGreaterThan(
      Date.parse(state.threadLastVisitedAtById[threadKey]!),
    );
  });
});
