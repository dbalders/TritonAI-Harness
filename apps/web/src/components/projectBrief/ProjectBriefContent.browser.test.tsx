import { ProjectId, ThreadId, RunId, type ProjectBriefState } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, render as renderUi, type Screen } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectBriefContent, type ProjectBriefAction } from "./ProjectBriefContent";
import { ProjectBriefArchiveView } from "./ProjectBriefArchiveView";
import { projectBriefSafeSourceUrl } from "./projectBriefView";

vi.mock("../ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children: ReactNode;
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
}));
vi.mock("../ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
vi.mock("../ui/textarea", () => ({ Textarea: (props: object) => <textarea {...props} /> }));
vi.mock("../ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

const now = "2026-10-17T18:00:00.000Z";
function fixture(): ProjectBriefState {
  return {
    projectId: ProjectId.make("project-1"),
    revision: 4,
    sourceDigest: "current-sources",
    sources: [
      {
        id: "source-1",
        selection: { kind: "file", relativePath: "notes.md" },
        snapshotId: "snapshot-1",
        status: "available",
      },
    ],
    snapshots: [
      {
        id: "snapshot-1",
        sourceId: "source-1",
        title: "Project notes",
        text: "Exports must preserve audio.",
        revision: "file-rev-1",
        digest: "file-digest",
        capturedAt: now,
      },
    ],
    synthesis: {
      id: "synthesis-1",
      sourceDigest: "current-sources",
      snapshotIds: ["snapshot-1"],
      threadId: ThreadId.make("brief-thread"),
      runId: RunId.make("brief-run"),
      commandId: "generate-1",
      status: "published",
    },
    brief: {
      summary: "Audio preservation needs a checked export.",
      generatedAt: now,
      sourceDigest: "current-sources",
      threadId: ThreadId.make("brief-thread"),
      runId: RunId.make("brief-run"),
    },
    proposals: [
      {
        id: "action-1",
        synthesisId: "synthesis-1",
        sourceDigest: "current-sources",
        approvalDigest: "approval-1",
        kind: "action",
        title: "Check export audio",
        body: "Export the reference clip and inspect audio.",
        completionCriteria: "The audio channels match the source.",
        citations: [{ snapshotId: "snapshot-1", quote: "Exports must preserve audio." }],
        status: "accepted",
      },
    ],
    executions: [],
  };
}
describe("Project brief owner review", () => {
  it("reads an archive without mutation controls and preserves removed source versions and unreviewed results", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    const openThread = vi.fn();
    await act(async () => {
      _fixture.renderer = _fixture.stack.use(
        await renderUi(
          <ProjectBriefArchiveView
            archive={{
              id: "archive-1",
              archivedAt: now,
              state: {
                ...state,
                sources: [],
                executions: [
                  {
                    id: "execution-1",
                    proposalId: "action-1",
                    sourceDigest: "current-sources",
                    approvedDigest: "approval-1",
                    threadId: ThreadId.make("work-thread"),
                    runId: RunId.make("work-run"),
                    commandId: "launch-1",
                    status: "needs-review",
                    result: {
                      summary: "The channels match.",
                      artifacts: [],
                      digest: "result-1",
                      reportedAt: now,
                      runId: RunId.make("work-run"),
                    },
                    reviewedAt: null,
                    createdAt: now,
                    stopRequested: false,
                  },
                ],
              },
            }}
            openThread={openThread}
          />,
          { router: false /* These subjects use mocked navigation or no routing. */ },
        ),
      );
    });
    expect(_fixture.text(_fixture.renderer!.container)).toContain("This brief is read-only");
    expect(_fixture.text(_fixture.renderer!.container)).toContain("Exports must preserve audio.");
    expect(_fixture.text(_fixture.renderer!.container)).toContain("Ready for your review");
    expect(_fixture.text(_fixture.renderer!.container)).not.toContain("requires permission");
    expect(_fixture.button("Mark reviewed complete")).toBeUndefined();
    expect(_fixture.button("Accept")).toBeUndefined();
    expect(_fixture.button("Archive & start fresh")).toBeUndefined();
    await act(() => _fixture.button("Open work thread").click());
    expect(openThread).toHaveBeenCalledExactlyOnceWith(ThreadId.make("work-thread"));
    expect(_fixture.run).not.toHaveBeenCalled();
  });

  it("requires reviewing the current version before archiving and leaves failed archive attempts open", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount(state);
    await act(() => _fixture.button("Archive & start fresh").click());
    expect(_fixture.run).not.toHaveBeenCalled();
    expect(_fixture.text(_fixture.renderer!.container)).toContain(
      "preserved in a read-only saved brief",
    );
    await act(() =>
      _fixture.renderer!.rerender(_fixture.content({ ...state, revision: state.revision + 1 })),
    );
    expect(_fixture.button("Save brief & start fresh").disabled).toBe(true);
    await act(() => _fixture.button("Keep current brief").click());
    await act(() => _fixture.button("Archive & start fresh").click());
    _fixture.run.mockResolvedValueOnce(false);
    await act(() => _fixture.button("Save brief & start fresh").click());
    expect(_fixture.button("Save brief & start fresh")).toBeDefined();
    expect(_fixture.text(_fixture.renderer!.container)).toContain(
      "Audio preservation needs a checked export.",
    );
    expect(_fixture.run).toHaveBeenCalledExactlyOnceWith({ action: "archive" });
  });

  it("blocks archiving while generation status is uncertain instead of silently retiring it", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount({ ...state, synthesis: { ...state.synthesis!, status: "uncertain" } });
    expect(_fixture.button("Archive & start fresh").disabled).toBe(true);
    expect(_fixture.text(_fixture.renderer!.container)).toContain(
      "discard any unfinished generation before archiving",
    );
    expect(_fixture.run).not.toHaveBeenCalled();
  });

  it("keeps a missing terminal result open and offers a new reviewed revision", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount({
      ...state,
      executions: [
        {
          id: "execution-1",
          proposalId: "action-1",
          sourceDigest: "current-sources",
          approvedDigest: "approval-1",
          threadId: ThreadId.make("work-thread"),
          runId: RunId.make("work-run"),
          commandId: "launch-1",
          status: "result-missing",
          result: null,
          reviewedAt: null,
          createdAt: now,
          stopRequested: false,
        },
      ],
    });
    expect(_fixture.text(_fixture.renderer!.container)).toContain("Result missing");
    expect(_fixture.text(_fixture.renderer!.container)).toContain(
      "finished without returning a verified result",
    );
    expect(_fixture.button("Mark reviewed complete")).toBeUndefined();
    expect(_fixture.button("Review result")).toBeUndefined();
    await act(() => _fixture.button("Prepare revision").click());
    expect(_fixture.run).toHaveBeenCalledExactlyOnceWith({
      action: "revise",
      proposalId: "action-1",
    });
  });

  it("allows retrying an interrupted stop and never offers to restart that work", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount({
      ...state,
      executions: [
        {
          id: "execution-1",
          proposalId: "action-1",
          sourceDigest: "current-sources",
          approvedDigest: "approval-1",
          threadId: ThreadId.make("work-thread"),
          runId: RunId.make("work-run"),
          commandId: "launch-1",
          status: "uncertain",
          result: null,
          reviewedAt: null,
          createdAt: now,
          stopRequested: true,
        },
      ],
    });
    expect(_fixture.text(_fixture.renderer!.container)).toContain("Stop requested");
    expect(_fixture.button("Retry stop").disabled).toBe(false);
    expect(_fixture.button("Retry starting work thread")).toBeUndefined();
    _fixture.run.mockResolvedValueOnce(false);
    await act(() => _fixture.button("Retry stop").click());
    expect(_fixture.button("Retry stop").disabled).toBe(false);
    await act(() => _fixture.button("Retry stop").click());
    expect(_fixture.run).toHaveBeenCalledTimes(2);
    expect(_fixture.run).toHaveBeenLastCalledWith({ action: "cancel", executionId: "execution-1" });
  });

  it("requires explicit discard confirmation and pins it to the generation reviewed", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    const pending = { ...state, synthesis: { ...state.synthesis!, status: "uncertain" as const } };
    await _fixture.mount(pending);
    await act(() => _fixture.button("Discard this generation").click());
    expect(_fixture.run).not.toHaveBeenCalled();
    expect(_fixture.text(_fixture.renderer!.container)).toContain(
      "Its original thread may still be running",
    );
    await act(() =>
      _fixture.renderer!.rerender(
        _fixture.content({ ...pending, synthesis: { ...pending.synthesis, id: "synthesis-2" } }),
      ),
    );
    expect(_fixture.button("Confirm discard").disabled).toBe(true);
    await act(() => _fixture.button("Keep generation").click());
    await act(() => _fixture.button("Discard this generation").click());
    await act(() => _fixture.button("Confirm discard").click());
    expect(_fixture.run).toHaveBeenCalledExactlyOnceWith({
      action: "discardGeneration",
      synthesisId: "synthesis-2",
    });
  });

  it.each(["uncertain", "dispatch-pending"] as const)(
    "requires current withdrawal review for %s work and preserves inspection without retry or completion",
    async (status) => {
      await using _fixture = await setupTest();

      const state = fixture();
      const execution = {
        id: "execution-1",
        proposalId: "action-1",
        sourceDigest: "current-sources",
        approvedDigest: "approval-1",
        threadId: ThreadId.make("work-thread"),
        runId: null,
        commandId: "launch-1",
        status,
        result: null,
        reviewedAt: null,
        createdAt: now,
        stopRequested: false,
      };
      const uncertain = { ...state, executions: [execution] };
      await _fixture.mount(uncertain);
      expect(_fixture.button("Archive & start fresh").disabled).toBe(true);
      await act(() => _fixture.button("Withdraw tracking").click());
      expect(_fixture.run).not.toHaveBeenCalled();
      expect(_fixture.text(_fixture.renderer!.container)).toContain(
        "original thread may still be running",
      );
      const changed = { ...uncertain, revision: state.revision + 1, sourceDigest: "new-sources" };
      await act(() => _fixture.renderer!.rerender(_fixture.content(changed)));
      expect(_fixture.button("Confirm withdrawal").disabled).toBe(true);
      await act(() => _fixture.button("Keep tracking").click());
      await act(() => _fixture.button("Withdraw tracking").click());
      _fixture.run.mockResolvedValueOnce(false);
      await act(() => _fixture.button("Confirm withdrawal").click());
      expect(_fixture.button("Confirm withdrawal")).toBeDefined();
      expect(_fixture.run).toHaveBeenCalledExactlyOnceWith({
        action: "withdrawExecution",
        executionId: "execution-1",
      });
      await act(() =>
        _fixture.renderer!.rerender(
          _fixture.content({
            ...changed,
            revision: changed.revision + 1,
            executions: [{ ...execution, status: "withdrawn" }],
          }),
        ),
      );
      expect(_fixture.button("Confirm withdrawal").disabled).toBe(true);
      await act(() => _fixture.button("Keep tracking").click());
      expect(_fixture.text(_fixture.renderer!.container)).toContain("Tracking withdrawn");
      expect(_fixture.button("Retry starting work thread")).toBeUndefined();
      expect(_fixture.button("Stop work")).toBeUndefined();
      expect(_fixture.button("Retry stop")).toBeUndefined();
      expect(_fixture.button("Mark reviewed complete")).toBeUndefined();
      expect(_fixture.button("Open work thread")).toBeDefined();
      expect(_fixture.button("Archive & start fresh").disabled).toBe(false);
      expect(_fixture.run).toHaveBeenCalledTimes(1);
    },
  );

  it("requires a separate launch review after accepting an action", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount({
      ...state,
      proposals: state.proposals.map((proposal) => ({ ...proposal, status: "proposed" })),
    });
    await act(() => _fixture.button("Accept next step").click());
    expect(_fixture.run.mock.calls.map(([command]) => command.action)).toEqual(["decide"]);
    await act(() => _fixture.renderer!.rerender(_fixture.content(state)));
    await act(() => _fixture.button("Review & start thread").click());
    expect(_fixture.run).toHaveBeenCalledTimes(1);
    expect(_fixture.text(_fixture.renderer!.container)).toContain("The agent receives this action");
    await act(() => _fixture.button("Start thread").click());
    expect(_fixture.run).toHaveBeenLastCalledWith({
      action: "launch",
      proposalId: "action-1",
      approvedDigest: "approval-1",
    });
  });

  it("invalidates an open launch review if the approved proposal changes", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount(state);
    await act(() => _fixture.button("Review & start thread").click());
    await act(() =>
      _fixture.renderer!.rerender(
        _fixture.content({
          ...state,
          proposals: state.proposals.map((proposal) => ({
            ...proposal,
            approvalDigest: "approval-2",
            body: "An edited task.",
          })),
        }),
      ),
    );
    expect(_fixture.button("Start thread").disabled).toBe(true);
    expect(_fixture.text(_fixture.renderer!.container)).toContain(
      "This proposal changed while you were reviewing it",
    );
    expect(_fixture.run).not.toHaveBeenCalled();
  });

  it("preserves unsaved edits and blocks saving over a changed proposal", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount(state);
    await act(() => _fixture.button("Edit").click());
    await _fixture.editField("Proposal text", "My revised instructions.");
    await act(() =>
      _fixture.renderer!.rerender(
        _fixture.content({
          ...state,
          proposals: state.proposals.map((proposal) => ({
            ...proposal,
            approvalDigest: "approval-2",
            body: "Someone else's edit.",
          })),
        }),
      ),
    );
    expect(_fixture.field("Proposal text").value).toBe("My revised instructions.");
    expect(_fixture.button("Save proposal").disabled).toBe(true);
    expect(_fixture.text(_fixture.renderer!.container)).toContain(
      "This proposal changed while you were editing",
    );
    expect(_fixture.run).not.toHaveBeenCalled();
  });

  it("offers an explicit retry for uncertain startup without silently starting another thread", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount({ ...state, synthesis: { ...state.synthesis!, status: "uncertain" } });
    expect(_fixture.run).not.toHaveBeenCalled();
    expect(_fixture.button("Generate new proposal").disabled).toBe(true);
    await act(() => _fixture.button("Retry starting brief thread").click());
    expect(_fixture.run).toHaveBeenCalledExactlyOnceWith({ action: "retry" });
  });

  it("blocks accepting or launching when refreshed source versions have changed", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount({ ...state, sourceDigest: "changed-sources" });
    expect(_fixture.button("Review & start thread").disabled).toBe(true);
    expect(_fixture.text(_fixture.renderer!.container)).toContain(
      "Sources changed since this brief",
    );
    expect(_fixture.button("Generate new proposal").disabled).toBe(false);
  });

  it("keeps an agent result separate from owner completion and binds review to the displayed result", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    const execution = {
      id: "execution-1",
      proposalId: "action-1",
      sourceDigest: "current-sources",
      approvedDigest: "approval-1",
      threadId: ThreadId.make("work-thread"),
      runId: RunId.make("work-run"),
      commandId: "launch-1",
      status: "needs-review" as const,
      result: {
        summary: "The channels match.",
        artifacts: [{ relativePath: "report.txt", digest: "artifact-1", sizeBytes: 40 }],
        digest: "result-1",
        reportedAt: now,
        runId: RunId.make("work-run"),
      },
      reviewedAt: null,
      createdAt: now,
      stopRequested: false,
    };
    await _fixture.mount({ ...state, executions: [execution] });
    expect(_fixture.text(_fixture.renderer!.container)).toContain("Ready for your review");
    expect(_fixture.run).not.toHaveBeenCalled();
    await act(() => _fixture.button("Review result").click());
    await act(() =>
      _fixture.renderer!.rerender(
        _fixture.content({
          ...state,
          executions: [
            {
              ...execution,
              result: { ...execution.result, digest: "result-2", summary: "Updated result." },
            },
          ],
        }),
      ),
    );
    expect(_fixture.button("Mark reviewed complete").disabled).toBe(true);
    expect(_fixture.text(_fixture.renderer!.container)).toContain("The result changed");
    expect(_fixture.run).not.toHaveBeenCalled();
  });

  it("keeps failed source input intact for correction and does not import a pasted URL", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount({
      ...state,
      sources: [],
      snapshots: [],
      brief: null,
      proposals: [],
      synthesis: null,
    });
    expect(_fixture.button("Generate brief").disabled).toBe(true);
    await userEvent.click(
      _fixture.renderer.getByRole("button", { name: "Choose sources", exact: true }),
    );
    await _fixture.editField("Source type", "excerpt");
    for (const [label, value] of [
      ["Source title", "Meeting notes"],
      ["Source excerpt", "Review the export."],
      ["Original source URL", "https://example.com/private-note"],
    ] as const) {
      await _fixture.editField(label, value);
    }
    _fixture.run.mockResolvedValueOnce(false);
    await userEvent.click(
      _fixture.renderer.getByRole("button", { name: "Add source", exact: true }),
    );
    await vi.waitFor(() =>
      expect(_fixture.run).toHaveBeenLastCalledWith({
        action: "addSource",
        source: {
          kind: "excerpt",
          title: "Meeting notes",
          text: "Review the export.",
          url: "https://example.com/private-note",
        },
      }),
    );
    expect(_fixture.field("Source excerpt").value).toBe("Review the export.");
    expect(_fixture.text(_fixture.renderer!.container)).toContain(
      "the page is not imported or refreshed",
    );
  });

  it("does not submit a previously chosen message after switching source types", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await act(async () => {
      _fixture.renderer = _fixture.stack.use(
        await renderUi(
          <ProjectBriefContent
            state={{
              ...state,
              sources: [],
              snapshots: [],
              brief: null,
              proposals: [],
              synthesis: null,
            }}
            busy={false}
            canWrite
            error={null}
            run={_fixture.run}
            modelControl={null}
            modelReady
            openThread={() => {}}
            renderMessagePicker={(onSelect) => (
              <button type="button" onClick={() => onSelect("thread-1", "message-1")}>
                Pick message
              </button>
            )}
          />,
          { router: false /* These subjects use mocked navigation or no routing. */ },
        ),
      );
    });
    await userEvent.click(
      _fixture.renderer.getByRole("button", { name: "Choose sources", exact: true }),
    );
    await _fixture.editField("Source type", "message");
    await userEvent.click(
      _fixture.renderer.getByRole("button", { name: "Pick message", exact: true }),
    );
    await expect
      .element(_fixture.renderer.getByRole("button", { name: "Add source", exact: true }))
      .toBeEnabled();
    await _fixture.editField("Source type", "file");
    await _fixture.editField("Source type", "message");
    await expect
      .element(_fixture.renderer.getByRole("button", { name: "Add source", exact: true }))
      .toBeDisabled();
    await act(() =>
      _fixture.renderer!.container.querySelector<HTMLFormElement>("form")!.requestSubmit(),
    );
    expect(_fixture.run).not.toHaveBeenCalled();
  });

  it("removes mutation access when the environment permission changes", async () => {
    await using _fixture = await setupTest();

    const state = fixture();
    await _fixture.mount(state);
    await userEvent.click(
      _fixture.renderer.getByRole("button", { name: "Review & start thread", exact: true }),
    );
    await _fixture.renderer.rerender(_fixture.content(state, false));
    await expect
      .element(_fixture.renderer.getByRole("button", { name: "Start thread", exact: true }))
      .toBeDisabled();
    await expect
      .element(_fixture.renderer.getByRole("button", { name: "Add", exact: true }))
      .toBeDisabled();
    expect(_fixture.run).not.toHaveBeenCalled();
  });

  it("does not turn unsafe source URLs into links", async () => {
    await using _fixture = await setupTest();

    expect(projectBriefSafeSourceUrl("javascript:alert(1)")).toBeNull();
    expect(projectBriefSafeSourceUrl("file:///private/note")).toBeNull();
    expect(projectBriefSafeSourceUrl("https://example.com/note")).toBe("https://example.com/note");
  });
});

async function setupTest() {
  const stack = new AsyncDisposableStack();
  let renderer: Screen;

  const run = vi.fn<(command: ProjectBriefAction) => Promise<boolean>>();
  function text(node: Element): string {
    return node.textContent ?? "";
  }
  function field(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
    return renderer.container.querySelector('[aria-label="' + label + '"]')!;
  }
  async function editField(label: string, value: string) {
    const locator = renderer.getByLabelText(label, { exact: true });
    await expect.element(locator).toBeVisible();
    if (locator.element() instanceof HTMLSelectElement) {
      await userEvent.selectOptions(locator, value);
    } else {
      await userEvent.clear(locator);
      if (value) await userEvent.type(locator, value);
    }
    await expect.element(locator).toHaveValue(value);
  }
  function button(label: string) {
    return Array.from(renderer!.container.querySelectorAll<HTMLButtonElement>("button")).find(
      (node) => text(node) === label,
    )!;
  }
  function content(state: ProjectBriefState, canWrite = true) {
    return (
      <ProjectBriefContent
        state={state}
        busy={false}
        canWrite={canWrite}
        error={null}
        run={run}
        modelControl={null}
        modelReady
        openThread={() => {}}
      />
    );
  }
  async function mount(state: ProjectBriefState) {
    renderer = stack.use(
      await renderUi(content(state), {
        router: false /* These subjects use mocked navigation or no routing. */,
      }),
    );
  }

  run.mockReset().mockResolvedValue(true);

  stack.defer(async () => {
    vi.unstubAllGlobals();
  });
  return {
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
    stack,
    get renderer() {
      return renderer;
    },
    set renderer(value: typeof renderer) {
      renderer = value;
    },
    run,
    text,
    field,
    editField,
    button,
    content,
    mount,
  };
}
