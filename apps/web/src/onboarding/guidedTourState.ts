import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { OnboardingMailProvider, OnboardingRoleId } from "./guidedOnboarding.logic";

// Where the person is in the experimental guided tour, kept for this browser session.
// The tour ends in the real chat: `taskThreadId` is the conversation its first task runs
// in, where follow-up suggestions appear until the person dismisses them.

export type GuidedTourStep = "welcome" | "role" | "task" | "connect" | "file";

export interface GuidedTourState {
  readonly step: GuidedTourStep;
  readonly roleId: OnboardingRoleId | null;
  readonly taskId: string | null;
  /** The email account they chose on the Connect step. */
  readonly provider: OnboardingMailProvider | null;
  /** The conversation the first task runs in, and the environment that owns it. */
  readonly taskEnvironmentId: EnvironmentId | null;
  readonly taskThreadId: ThreadId | null;
  /** Follow-up suggestions already used, so each is offered once. */
  readonly usedFollowUps: ReadonlyArray<string>;
  /** They closed the suggestions in the chat. */
  readonly chatGuideDismissed: boolean;
}

const STORAGE_KEY = "tritonai:guided-tour:v3";
const INITIAL_STATE: GuidedTourState = {
  step: "welcome",
  roleId: null,
  taskId: null,
  provider: null,
  taskEnvironmentId: null,
  taskThreadId: null,
  usedFollowUps: [],
  chatGuideDismissed: false,
};

const listeners = new Set<() => void>();
let state: GuidedTourState = readStoredState();

function readStoredState(): GuidedTourState {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    return raw
      ? { ...INITIAL_STATE, ...(JSON.parse(raw) as Partial<GuidedTourState>) }
      : INITIAL_STATE;
  } catch {
    return INITIAL_STATE;
  }
}

export function readGuidedTourState(): GuidedTourState {
  return state;
}

export function updateGuidedTourState(patch: Partial<GuidedTourState>): void {
  state = { ...state, ...patch };
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Without session storage the tour still works; it just won't resume after a reload.
  }
  for (const listener of listeners) listener();
}

/**
 * Start again from the welcome screen. This forgets the tour's own progress and its
 * chat guide; the conversations it created stay in the sidebar like any other chat.
 */
export function restartGuidedTour(): void {
  updateGuidedTourState(INITIAL_STATE);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGuidedTourState(): GuidedTourState {
  return useSyncExternalStore(subscribe, readGuidedTourState, readGuidedTourState);
}
