import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

function renderActions(overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>>) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
      ...overrides,
    }),
  );
}

describe("ComposerPrimaryActions", () => {
  it("blocks sending while feedback is uploading", () => {
    const markup = renderActions({
      promptHasText: true,
      hasSendableContent: true,
      sendDisabledReason: "Sending feedback",
    });
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it.each([true, false])("offers Stop for pending input only while running: %s", (isRunning) => {
    const markup = renderActions({
      isRunning,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
    });
    expect(markup.includes('aria-label="Stop generation"')).toBe(isRunning);
  });

  it.each([true, false])(
    "offers Queue alongside Stop only with a sendable draft: %s",
    (hasSendableContent) => {
      const markup = renderActions({
        isRunning: true,
        promptHasText: hasSendableContent,
        hasSendableContent,
      });
      expect(markup).toContain('aria-label="Stop generation"');
      expect(markup.includes('aria-label="Queue message"')).toBe(hasSendableContent);
      if (hasSendableContent) expect(markup).toContain('type="submit"');
    },
  );
});
