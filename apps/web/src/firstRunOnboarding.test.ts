import { describe, expect, it } from "vite-plus/test";

import {
  getTritonAiFirstRunOnboardingDecision,
  hasPriorProjectOrConversationState,
  shouldRunTritonAiFirstRunOnboarding,
} from "./firstRunOnboarding";

const READY_INPUT = {
  isBranded: true,
  markerCompleted: false,
  clientSettingsHydrated: true,
  composerDraftsHydrated: true,
  primaryEnvironmentReady: true,
  primaryEnvironmentBootstrapped: true,
  routePathname: "/",
  projectCount: 0,
  nonOnboardingProjectCount: 0,
  threadCount: 0,
  draftThreadCount: 0,
  composerDraftCount: 0,
  existingTritonAiWorkspace: false,
} as const;

describe("firstRunOnboarding", () => {
  it("treats existing non-onboarding projects, threads, and drafts as prior state", () => {
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 1,
        nonOnboardingProjectCount: 1,
        threadCount: 0,
        draftThreadCount: 0,
        composerDraftCount: 0,
        existingTritonAiWorkspace: false,
      }),
    ).toBe(true);
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 1,
        nonOnboardingProjectCount: 0,
        threadCount: 0,
        draftThreadCount: 0,
        composerDraftCount: 0,
        existingTritonAiWorkspace: true,
      }),
    ).toBe(false);
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 2,
        nonOnboardingProjectCount: 1,
        threadCount: 0,
        draftThreadCount: 0,
        composerDraftCount: 0,
        existingTritonAiWorkspace: true,
      }),
    ).toBe(true);
    expect(
      hasPriorProjectOrConversationState({
        projectCount: 0,
        nonOnboardingProjectCount: 0,
        threadCount: 1,
        draftThreadCount: 0,
        composerDraftCount: 0,
        existingTritonAiWorkspace: false,
      }),
    ).toBe(true);
  });

  it("runs once on a fully hydrated empty first launch", () => {
    expect(shouldRunTritonAiFirstRunOnboarding(READY_INPUT)).toBe(true);
    expect(shouldRunTritonAiFirstRunOnboarding({ ...READY_INPUT, markerCompleted: true })).toBe(
      false,
    );
  });

  it("does not create a duplicate after restart or when conversation state exists", () => {
    expect(shouldRunTritonAiFirstRunOnboarding({ ...READY_INPUT, draftThreadCount: 1 })).toBe(
      false,
    );
    expect(shouldRunTritonAiFirstRunOnboarding({ ...READY_INPUT, composerDraftCount: 1 })).toBe(
      false,
    );
    expect(shouldRunTritonAiFirstRunOnboarding({ ...READY_INPUT, threadCount: 1 })).toBe(false);
    expect(
      shouldRunTritonAiFirstRunOnboarding({
        ...READY_INPUT,
        projectCount: 1,
        nonOnboardingProjectCount: 1,
      }),
    ).toBe(false);
  });

  it("runs only on the root route and permits the empty onboarding workspace", () => {
    expect(shouldRunTritonAiFirstRunOnboarding({ ...READY_INPUT, routePathname: "/draft/1" })).toBe(
      false,
    );
    expect(
      shouldRunTritonAiFirstRunOnboarding({
        ...READY_INPUT,
        projectCount: 1,
        nonOnboardingProjectCount: 0,
        existingTritonAiWorkspace: true,
      }),
    ).toBe(true);
  });

  it("defers non-root routes instead of completing the onboarding marker", () => {
    expect(
      getTritonAiFirstRunOnboardingDecision({
        ...READY_INPUT,
        routePathname: "/settings",
      }),
    ).toBe("defer");
    expect(
      getTritonAiFirstRunOnboardingDecision({
        ...READY_INPUT,
        projectCount: 1,
        nonOnboardingProjectCount: 1,
      }),
    ).toBe("complete");
  });
});
