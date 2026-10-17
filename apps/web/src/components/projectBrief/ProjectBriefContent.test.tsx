import { ProjectId, ThreadId, RunId, type ProjectBriefState } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
let renderer: ReactTestRenderer | undefined;
const run = vi.fn<(command: ProjectBriefAction) => Promise<boolean>>();
function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}
function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => text(node) === label)!;
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
  await act(() => {
    renderer = create(content(state));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  run.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("Project brief owner review", () => {
  it("reads an archive without mutation controls and preserves removed source versions and unreviewed results", async () => {
    const state = fixture();
    const openThread = vi.fn();
    await act(() => {
      renderer = create(
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
      );
    });
    expect(text(renderer!.root)).toContain("This brief is read-only");
    expect(text(renderer!.root)).toContain("Exports must preserve audio.");
    expect(text(renderer!.root)).toContain("Ready for your review");
    expect(text(renderer!.root)).not.toContain("requires permission");
    expect(button("Mark reviewed complete")).toBeUndefined();
    expect(button("Accept")).toBeUndefined();
    expect(button("Archive & start fresh")).toBeUndefined();
    await act(() => button("Open work thread").props.onClick());
    expect(openThread).toHaveBeenCalledExactlyOnceWith(ThreadId.make("work-thread"));
    expect(run).not.toHaveBeenCalled();
  });

  it("requires reviewing the current version before archiving and leaves failed archive attempts open", async () => {
    const state = fixture();
    await mount(state);
    await act(() => button("Archive & start fresh").props.onClick());
    expect(run).not.toHaveBeenCalled();
    expect(text(renderer!.root)).toContain("preserved in a read-only saved brief");
    await act(() => renderer!.update(content({ ...state, revision: state.revision + 1 })));
    expect(button("Save brief & start fresh").props.disabled).toBe(true);
    await act(() => button("Keep current brief").props.onClick());
    await act(() => button("Archive & start fresh").props.onClick());
    run.mockResolvedValueOnce(false);
    await act(() => button("Save brief & start fresh").props.onClick());
    expect(button("Save brief & start fresh")).toBeDefined();
    expect(text(renderer!.root)).toContain("Audio preservation needs a checked export.");
    expect(run).toHaveBeenCalledExactlyOnceWith({ action: "archive" });
  });

  it("blocks archiving while generation status is uncertain instead of silently retiring it", async () => {
    const state = fixture();
    await mount({ ...state, synthesis: { ...state.synthesis!, status: "uncertain" } });
    expect(button("Archive & start fresh").props.disabled).toBe(true);
    expect(text(renderer!.root)).toContain("discard any unfinished generation before archiving");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps a missing terminal result open and offers a new reviewed revision", async () => {
    const state = fixture();
    await mount({
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
    expect(text(renderer!.root)).toContain("Result missing");
    expect(text(renderer!.root)).toContain("finished without returning a verified result");
    expect(button("Mark reviewed complete")).toBeUndefined();
    expect(button("Review result")).toBeUndefined();
    await act(() => button("Prepare revision").props.onClick());
    expect(run).toHaveBeenCalledExactlyOnceWith({ action: "revise", proposalId: "action-1" });
  });

  it("allows retrying an interrupted stop and never offers to restart that work", async () => {
    const state = fixture();
    await mount({
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
    expect(text(renderer!.root)).toContain("Stop requested");
    expect(button("Retry stop").props.disabled).toBe(false);
    expect(button("Retry starting work thread")).toBeUndefined();
    run.mockResolvedValueOnce(false);
    await act(() => button("Retry stop").props.onClick());
    expect(button("Retry stop").props.disabled).toBe(false);
    await act(() => button("Retry stop").props.onClick());
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith({ action: "cancel", executionId: "execution-1" });
  });

  it("requires explicit discard confirmation and pins it to the generation reviewed", async () => {
    const state = fixture();
    const pending = { ...state, synthesis: { ...state.synthesis!, status: "uncertain" as const } };
    await mount(pending);
    await act(() => button("Discard this generation").props.onClick());
    expect(run).not.toHaveBeenCalled();
    expect(text(renderer!.root)).toContain("Its original thread may still be running");
    await act(() =>
      renderer!.update(
        content({ ...pending, synthesis: { ...pending.synthesis, id: "synthesis-2" } }),
      ),
    );
    expect(button("Confirm discard").props.disabled).toBe(true);
    await act(() => button("Keep generation").props.onClick());
    await act(() => button("Discard this generation").props.onClick());
    await act(() => button("Confirm discard").props.onClick());
    expect(run).toHaveBeenCalledExactlyOnceWith({
      action: "discardGeneration",
      synthesisId: "synthesis-2",
    });
  });

  it.each(["uncertain", "dispatch-pending"] as const)(
    "requires current withdrawal review for %s work and preserves inspection without retry or completion",
    async (status) => {
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
      await mount(uncertain);
      expect(button("Archive & start fresh").props.disabled).toBe(true);
      await act(() => button("Withdraw tracking").props.onClick());
      expect(run).not.toHaveBeenCalled();
      expect(text(renderer!.root)).toContain("original thread may still be running");
      const changed = { ...uncertain, revision: state.revision + 1, sourceDigest: "new-sources" };
      await act(() => renderer!.update(content(changed)));
      expect(button("Confirm withdrawal").props.disabled).toBe(true);
      await act(() => button("Keep tracking").props.onClick());
      await act(() => button("Withdraw tracking").props.onClick());
      run.mockResolvedValueOnce(false);
      await act(() => button("Confirm withdrawal").props.onClick());
      expect(button("Confirm withdrawal")).toBeDefined();
      expect(run).toHaveBeenCalledExactlyOnceWith({
        action: "withdrawExecution",
        executionId: "execution-1",
      });
      await act(() =>
        renderer!.update(
          content({
            ...changed,
            revision: changed.revision + 1,
            executions: [{ ...execution, status: "withdrawn" }],
          }),
        ),
      );
      expect(button("Confirm withdrawal").props.disabled).toBe(true);
      await act(() => button("Keep tracking").props.onClick());
      expect(text(renderer!.root)).toContain("Tracking withdrawn");
      expect(button("Retry starting work thread")).toBeUndefined();
      expect(button("Stop work")).toBeUndefined();
      expect(button("Retry stop")).toBeUndefined();
      expect(button("Mark reviewed complete")).toBeUndefined();
      expect(button("Open work thread")).toBeDefined();
      expect(button("Archive & start fresh").props.disabled).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it("requires a separate launch review after accepting an action", async () => {
    const state = fixture();
    await mount({
      ...state,
      proposals: state.proposals.map((proposal) => ({ ...proposal, status: "proposed" })),
    });
    await act(() => button("Accept next step").props.onClick());
    expect(run.mock.calls.map(([command]) => command.action)).toEqual(["decide"]);
    await act(() => renderer!.update(content(state)));
    await act(() => button("Review & start thread").props.onClick());
    expect(run).toHaveBeenCalledTimes(1);
    expect(text(renderer!.root)).toContain("The agent receives this action");
    await act(() => button("Start thread").props.onClick());
    expect(run).toHaveBeenLastCalledWith({
      action: "launch",
      proposalId: "action-1",
      approvedDigest: "approval-1",
    });
  });

  it("invalidates an open launch review if the approved proposal changes", async () => {
    const state = fixture();
    await mount(state);
    await act(() => button("Review & start thread").props.onClick());
    await act(() =>
      renderer!.update(
        content({
          ...state,
          proposals: state.proposals.map((proposal) => ({
            ...proposal,
            approvalDigest: "approval-2",
            body: "An edited task.",
          })),
        }),
      ),
    );
    expect(button("Start thread").props.disabled).toBe(true);
    expect(text(renderer!.root)).toContain("This proposal changed while you were reviewing it");
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves unsaved edits and blocks saving over a changed proposal", async () => {
    const state = fixture();
    await mount(state);
    await act(() => button("Edit").props.onClick());
    await act(() =>
      renderer!.root
        .findByProps({ "aria-label": "Proposal text" })
        .props.onChange({ target: { value: "My revised instructions." } }),
    );
    await act(() =>
      renderer!.update(
        content({
          ...state,
          proposals: state.proposals.map((proposal) => ({
            ...proposal,
            approvalDigest: "approval-2",
            body: "Someone else's edit.",
          })),
        }),
      ),
    );
    expect(renderer!.root.findByProps({ "aria-label": "Proposal text" }).props.value).toBe(
      "My revised instructions.",
    );
    expect(button("Save proposal").props.disabled).toBe(true);
    expect(text(renderer!.root)).toContain("This proposal changed while you were editing");
    expect(run).not.toHaveBeenCalled();
  });

  it("offers an explicit retry for uncertain startup without silently starting another thread", async () => {
    const state = fixture();
    await mount({ ...state, synthesis: { ...state.synthesis!, status: "uncertain" } });
    expect(run).not.toHaveBeenCalled();
    expect(button("Generate new proposal").props.disabled).toBe(true);
    await act(() => button("Retry starting brief thread").props.onClick());
    expect(run).toHaveBeenCalledExactlyOnceWith({ action: "retry" });
  });

  it("blocks accepting or launching when refreshed source versions have changed", async () => {
    const state = fixture();
    await mount({ ...state, sourceDigest: "changed-sources" });
    expect(button("Review & start thread").props.disabled).toBe(true);
    expect(text(renderer!.root)).toContain("Sources changed since this brief");
    expect(button("Generate new proposal").props.disabled).toBe(false);
  });

  it("keeps an agent result separate from owner completion and binds review to the displayed result", async () => {
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
    await mount({ ...state, executions: [execution] });
    expect(text(renderer!.root)).toContain("Ready for your review");
    expect(run).not.toHaveBeenCalled();
    await act(() => button("Review result").props.onClick());
    await act(() =>
      renderer!.update(
        content({
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
    expect(button("Mark reviewed complete").props.disabled).toBe(true);
    expect(text(renderer!.root)).toContain("The result changed");
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps failed source input intact for correction and does not import a pasted URL", async () => {
    const state = fixture();
    await mount({
      ...state,
      sources: [],
      snapshots: [],
      brief: null,
      proposals: [],
      synthesis: null,
    });
    expect(button("Generate brief").props.disabled).toBe(true);
    await act(() => button("Choose sources").props.onClick());
    await act(() =>
      renderer!.root
        .findByProps({ "aria-label": "Source type" })
        .props.onChange({ target: { value: "excerpt" } }),
    );
    for (const [label, value] of [
      ["Source title", "Meeting notes"],
      ["Source excerpt", "Review the export."],
      ["Original source URL", "https://example.com/private-note"],
    ]) {
      await act(() =>
        renderer!.root.findByProps({ "aria-label": label }).props.onChange({ target: { value } }),
      );
    }
    run.mockResolvedValueOnce(false);
    await act(() => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(run).toHaveBeenLastCalledWith({
      action: "addSource",
      source: {
        kind: "excerpt",
        title: "Meeting notes",
        text: "Review the export.",
        url: "https://example.com/private-note",
      },
    });
    expect(renderer!.root.findByProps({ "aria-label": "Source excerpt" }).props.value).toBe(
      "Review the export.",
    );
    expect(text(renderer!.root)).toContain("the page is not imported or refreshed");
  });

  it("removes mutation access when the environment permission changes", async () => {
    const state = fixture();
    await mount(state);
    await act(() => button("Review & start thread").props.onClick());
    await act(() => renderer!.update(content(state, false)));
    expect(button("Start thread").props.disabled).toBe(true);
    expect(button("Add").props.disabled).toBe(true);
  });

  it("does not turn unsafe source URLs into links", () => {
    expect(projectBriefSafeSourceUrl("javascript:alert(1)")).toBeNull();
    expect(projectBriefSafeSourceUrl("file:///private/note")).toBeNull();
    expect(projectBriefSafeSourceUrl("https://example.com/note")).toBe("https://example.com/note");
  });
});
