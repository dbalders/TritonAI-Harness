import { ProjectId, ThreadId, RunId, type ProjectBriefState } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, render as renderUi, type Screen } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProjectBriefContent, type ProjectBriefAction } from "./ProjectBriefContent";
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
