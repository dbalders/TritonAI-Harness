import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { QueuedComposerEntry } from "../../composerQueueStore";
import { QueuedComposerControl } from "./QueuedComposerControl";

const entry = (
  id: string,
  prompt: string,
  status: QueuedComposerEntry["status"] = "queued",
): QueuedComposerEntry =>
  ({
    id,
    createdAt: "2026-09-03T00:00:00.000Z",
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    selectedProvider: "codex",
    selectedInstanceId: "codex",
    selectedModel: "gpt-5",
    selectedProviderModels: [],
    selectedPromptEffort: null,
    selectedModelSelection: { instanceId: "codex", model: "gpt-5" },
    supportsThreadGoals: false,
    goalArmed: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    status,
    error: null,
  }) as unknown as QueuedComposerEntry;

describe("QueuedComposerControl", () => {
  it("renders multiple queued messages in order with explicit actions", () => {
    const html = renderToStaticMarkup(
      <QueuedComposerControl
        entries={[entry("one", "First queued prompt"), entry("two", "Second queued prompt")]}
        canSteer
        onSteer={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(html).toContain("2 queued messages");
    expect(html.indexOf("First queued prompt")).toBeLessThan(html.indexOf("Second queued prompt"));
    expect(html).toContain("Steer queued message now");
    expect(html).toContain("Queued message actions");
    expect(html).toContain("Remove queued message");
    expect(html).not.toContain("Edit queued message");
    expect(html).not.toContain("Collapse queued messages");
    expect(html).not.toContain("Move queued message");
  });

  it("shows only messages that are still waiting", () => {
    const html = renderToStaticMarkup(
      <QueuedComposerControl
        entries={[
          entry("sent", "Already in the transcript", "dispatching"),
          entry("waiting", "Still waiting"),
        ]}
        canSteer
        onSteer={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="1 queued message"');
    expect(html).toContain("Still waiting");
    expect(html).not.toContain("Already in the transcript");
  });

  it("removes the drawer when the only message has started sending", () => {
    const html = renderToStaticMarkup(
      <QueuedComposerControl
        entries={[entry("sent", "Already in the transcript", "dispatching")]}
        canSteer
        onSteer={() => undefined}
        onRemove={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(html).toBe("");
  });
});
