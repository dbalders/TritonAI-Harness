// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BotFileRecipesPanel, type BotFileRecipesPanelProps } from "./BotFileRecipesPanel";
import type { DotApproval, DotTask } from "./dotClient";
import type { DotFileRecipe, DotFileRecipeEvent, DotRecipeFolderListing } from "./dotFileRecipes";

const at = "2026-10-13T16:00:00.000Z";
const event = (overrides: Partial<DotFileRecipeEvent>): DotFileRecipeEvent => ({
  key: "0123456789abcdef01234567",
  version: {
    itemId: "item-1",
    name: "q3-report.md",
    cTag: "c1",
    size: 12,
    lastModifiedDateTime: at,
    webUrl: "https://contoso-my.sharepoint.com/Inbox/q3-report.md",
  },
  status: "settling",
  seenAt: at,
  updatedAt: at,
  current: true,
  startable: false,
  ...overrides,
});
const recipe = (overrides: Partial<DotFileRecipe> = {}): DotFileRecipe => ({
  recipeId: "fr_0123456789ab",
  name: "Inbox summaries",
  instructions: "Summarize each new report.",
  expectedOutput: "A short summary.",
  approval: "ask",
  folder: {
    folderId: "folder-inbox",
    name: "Inbox",
    webUrl: "https://contoso-my.sharepoint.com/Inbox",
  },
  status: "active",
  generation: 1,
  cadence: "about every 5 minutes",
  coverage: { complete: true, files: 3, folders: 0, other: 0, checkedAt: at },
  nextCheckAt: "2026-10-13T16:05:00.000Z",
  lastSuccessAt: at,
  events: [],
  createdAt: at,
  updatedAt: at,
  ...overrides,
});
const root: DotRecipeFolderListing = {
  folder: { folderId: "root-id", name: "root", webUrl: "https://contoso-my.sharepoint.com" },
  subfolders: [
    { folderId: "folder-inbox", name: "Inbox", webUrl: "https://contoso-my.sharepoint.com/Inbox" },
    {
      folderId: "folder-big",
      name: "Archive",
      webUrl: "https://contoso-my.sharepoint.com/Archive",
    },
  ],
  files: 0,
  complete: true,
};
const inbox: DotRecipeFolderListing = {
  folder: {
    folderId: "folder-inbox",
    name: "Inbox",
    webUrl: "https://contoso-my.sharepoint.com/Inbox",
  },
  subfolders: [],
  files: 3,
  complete: true,
};
const archive: DotRecipeFolderListing = {
  folder: { folderId: "folder-big", name: "Archive", webUrl: "" },
  subfolders: [],
  files: 100,
  complete: false,
  note: "This folder has more than 100 items.",
};

describe("BotFileRecipesPanel", () => {
  let reactRoot: Root;
  let container: HTMLDivElement;
  const handlers = {
    onBrowse: vi.fn<BotFileRecipesPanelProps["onBrowse"]>(),
    onCreate: vi.fn<BotFileRecipesPanelProps["onCreate"]>(),
    onEdit: vi.fn<BotFileRecipesPanelProps["onEdit"]>(),
    onAction: vi.fn<BotFileRecipesPanelProps["onAction"]>(),
    onStart: vi.fn<BotFileRecipesPanelProps["onStart"]>(),
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    for (const handler of Object.values(handlers)) handler.mockReset();
    handlers.onBrowse.mockImplementation(async (folderId) =>
      folderId === "folder-inbox" ? inbox : folderId === "folder-big" ? archive : root,
    );
    container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => reactRoot.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(props: Partial<BotFileRecipesPanelProps> = {}) {
    await act(async () =>
      reactRoot.render(
        <BotFileRecipesPanel
          recipes={[recipe()]}
          approvals={[]}
          tasks={[]}
          {...handlers}
          {...props}
        />,
      ),
    );
    const details = container.querySelector("details");
    if (details && !details.open)
      await act(async () => container.querySelector("summary")!.click());
  }
  function button(label: string, scope: ParentNode = container): HTMLButtonElement {
    const found = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
    expect(found, `Button ${label}`).toBeDefined();
    return found!;
  }
  async function click(label: string) {
    await act(async () => button(label).click());
  }
  async function type(label: string, value: string) {
    const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[aria-label="${label}"]`,
    )!;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
    await act(async () => {
      setter.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("creates a recipe only for a chosen folder that fits one page, with the owner's instructions and approval choice", async () => {
    handlers.onCreate.mockResolvedValue({});
    await render({ recipes: [] });
    await click("New file recipe");
    expect(handlers.onBrowse).toHaveBeenCalledWith(undefined);
    expect(button("Use “root”").disabled).toBe(true);
    await click("Open Archive");
    expect(container.textContent).toContain("more than 100 items");
    expect(button("Use “Archive”").disabled).toBe(true);
    await click("Up one level");
    await click("Open Inbox");
    await click("Use “Inbox”");
    expect(container.textContent).toContain("Folder: Inbox");
    await type("File recipe name", "Inbox summaries");
    await type("File recipe instructions", "Summarize each new report.");
    await type("File recipe expected result", "A short summary.");
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="File recipe approval"]',
    )!;
    await act(async () => {
      select.value = "review";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(handlers.onCreate).toHaveBeenCalledWith({
      name: "Inbox summaries",
      instructions: "Summarize each new report.",
      expectedOutput: "A short summary.",
      approval: "review",
      folderId: "folder-inbox",
    });
    expect(container.querySelector("form")).toBeNull();
  });

  it("keeps the editor open with the bot's reason when saving fails, and says when OneDrive is not connected", async () => {
    handlers.onCreate.mockRejectedValue(new Error("This folder has more than one page of items."));
    await render({ recipes: [] });
    await click("New file recipe");
    await click("Open Inbox");
    await click("Use “Inbox”");
    await type("File recipe name", "Inbox");
    await type("File recipe instructions", "Summarize");
    await type("File recipe expected result", "Summary");
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("more than one page");
    expect(container.querySelector("form")).not.toBeNull();
    await act(async () => reactRoot.unmount());
    reactRoot = createRoot(container);
    await render({ recipes: [], oneDriveConnected: false });
    expect(container.textContent).toContain("Connect OneDrive read access");
    expect(
      [...container.querySelectorAll("button")].some(
        (item) => item.textContent === "New file recipe",
      ),
    ).toBe(false);
  });

  it("shows each file's outcome from the decision and task records and lets the owner start only files that did not start", async () => {
    const approvals: DotApproval[] = [
      {
        approvalId: "approval-old",
        summary: "",
        action: "harness-task",
        payload: {},
        notStartable:
          "the file recipe “Inbox summaries” was paused, edited or reconnected after this file was read.",
      },
    ];
    const tasks: DotTask[] = [
      {
        taskId: "task-1",
        title: "Inbox summaries: done.md",
        status: "completed",
        createdAt: at,
        updatedAt: at,
        result: "Summary written.",
      },
    ];
    handlers.onStart
      .mockRejectedValueOnce(new Error("This file is no longer in the folder."))
      .mockResolvedValueOnce({});
    await render({
      approvals,
      tasks,
      recipes: [
        recipe({
          events: [
            event({
              key: "a".repeat(24),
              status: "needs-decision",
              approvalId: "approval-old",
              version: { ...event({}).version, name: "old.md" },
            }),
            event({
              key: "b".repeat(24),
              status: "assigned",
              taskId: "task-1",
              read: {
                sha256: "f".repeat(64),
                extension: "md",
                characters: 900,
                includedCharacters: 600,
                complete: false,
              },
              version: { ...event({}).version, name: "done.md" },
            }),
            event({
              key: "c".repeat(24),
              status: "not-started",
              startable: true,
              current: false,
              reason:
                "Arrived while this recipe was paused, so it did not start. Use Start to run it.",
              version: { ...event({}).version, name: "held.md", webUrl: "javascript:alert(1)" },
            }),
          ],
        }),
      ],
    });
    expect(container.textContent).toContain("can no longer start");
    expect(container.textContent).toContain("Harness returned a result.");
    expect(container.textContent).toContain("Partial text sent: 600 of 900 extracted characters");
    expect(container.textContent).toContain("Earlier settings");
    // An unsafe link from the service stays plain text.
    expect([...container.querySelectorAll("a")].map((item) => item.textContent)).not.toContain(
      "held.md",
    );
    expect(
      [...container.querySelectorAll("button")].filter((item) => item.textContent === "Start"),
    ).toHaveLength(1);
    await click("Start");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "no longer in the folder",
    );
    await click("Start");
    expect(handlers.onStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ recipeId: "fr_0123456789ab" }),
      expect.objectContaining({ key: "c".repeat(24) }),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Started");
  });

  it("states paused reasons and incomplete coverage truthfully, and confirms before stopping", async () => {
    handlers.onAction.mockResolvedValue({});
    await render({
      recipes: [
        recipe({
          status: "paused",
          pausedReason: "connection-changed",
          coverage: {
            complete: false,
            files: 100,
            folders: 0,
            other: 0,
            checkedAt: at,
            notListed: 4,
          },
          lastError: "This folder has more than 100 items.",
        }),
      ],
    });
    expect(container.textContent).toContain("Microsoft connection changed");
    expect(container.textContent).toContain("Incomplete: the folder has more than 100 items");
    expect(container.textContent).toContain("4 more files arrived during a gap");
    expect(container.textContent).toContain("Next check: Not scheduled");
    await click("Resume");
    expect(handlers.onAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 1 }),
      "resume",
    );
    await click("Stop");
    expect(handlers.onAction).toHaveBeenCalledTimes(1);
    await act(async () => button("Stop recipe", document.body).click());
    expect(handlers.onAction).toHaveBeenLastCalledWith(expect.anything(), "stop");
  });

  it("names the full-recipe blocker with its recovery, and says an unconfirmed outcome cannot be started", async () => {
    handlers.onAction.mockResolvedValue({});
    await render({
      recipes: [
        recipe({
          blocked: { waiting: 7, open: 20, limit: 20, since: at },
          events: [
            event({
              key: "d".repeat(24),
              status: "uncertain",
              reason:
                "Checking whether this file's decision or assignment was created. It can't be started again until that is confirmed.",
            }),
            event({
              key: "e".repeat(24),
              status: "failed",
              startable: true,
              reason:
                "Nothing was created for this file: it could not be read, or its run stopped before drafting. Use Start to try again.",
              version: { ...event({}).version, name: "retry.md" },
            }),
          ],
        }),
      ],
    });
    const notice = container.querySelector('[role="status"]')?.textContent ?? "";
    expect(notice).toContain("already holds 20 unfinished files");
    expect(notice).toContain("7 newer files are still in the folder");
    expect(notice).toContain("approve or decline waiting decisions");
    expect(notice).toContain("pause the recipe");
    expect(container.textContent).toContain("Needs attention");
    expect(container.textContent).toContain("Checking what happened");
    expect(container.textContent).toContain("Did not start");
    expect(
      [...container.querySelectorAll("button")].filter((item) => item.textContent === "Start"),
    ).toHaveLength(1);
    await click("Pause");
    expect(handlers.onAction).toHaveBeenLastCalledWith(expect.anything(), "pause");
  });

  it("refuses to save edits from an outdated version of the recipe", async () => {
    handlers.onEdit.mockResolvedValue({});
    await render();
    await click("Edit recipe");
    expect(container.querySelector('form[aria-label="Edit file recipe"]')).not.toBeNull();
    await render({ recipes: [recipe({ generation: 2, instructions: "Changed elsewhere." })] });
    expect(container.textContent).toContain("This recipe changed");
    expect(container.querySelector('form[aria-label="Edit file recipe"]')).toBeNull();
    await click("Close editor");
    await click("Edit recipe");
    await type("File recipe instructions", "Extract action items.");
    await act(async () => container.querySelector("form")!.requestSubmit());
    expect(handlers.onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2 }),
      expect.objectContaining({ instructions: "Extract action items." }),
    );
  });
});

describe("BotFileRecipesPanel waiting reasons", () => {
  let reactRoot: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => reactRoot.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const pending: DotApproval = {
    approvalId: "approval-1",
    status: "pending",
    summary: "Harness task: Inbox summaries: q3-report.md",
    action: "harness-task",
    payload: {},
  };

  it("resumes a paused recipe from its status and shows a file's authoritative decision over a stale label", async () => {
    const onAction = vi.fn<BotFileRecipesPanelProps["onAction"]>(async () => ({}));
    const onWaitingAction = vi.fn();
    const paused = recipe({
      status: "paused",
      pausedReason: "owner",
      waiting: {
        code: "recipe-paused",
        on: "you",
        text: "Paused by you. It doesn't check the folder until you resume it.",
        action: {
          kind: "resume-recipe",
          label: "Resume the recipe",
          target: { kind: "recipe", id: "fr_0123456789ab" },
        },
        next: [{ kind: "none", what: "No checks while paused." }],
      },
      events: [
        event({
          status: "needs-decision",
          approvalId: "approval-1",
          waiting: {
            code: "closed",
            on: "nothing",
            phase: "settled",
            text: "This file's assignment was declined. Nothing from it ran.",
            next: [{ kind: "none", what: "Nothing more happens to it." }],
            notes: ["The recipe's list updates at its next check."],
          },
        }),
      ],
    });
    await act(async () =>
      reactRoot.render(
        <BotFileRecipesPanel
          recipes={[paused]}
          approvals={[pending]}
          tasks={[]}
          onBrowse={vi.fn()}
          onCreate={vi.fn()}
          onEdit={vi.fn()}
          onAction={onAction}
          onStart={vi.fn()}
          onWaitingAction={onWaitingAction}
        />,
      ),
    );
    const text = container.textContent ?? "";
    // The stale pending copy in this snapshot would have said "Waiting in your decision inbox"; the service's reading wins.
    expect(text).toContain("This file's assignment was declined. Nothing from it ran.");
    expect(text).not.toContain("Waiting in your decision inbox");
    expect(text).toContain("Next check: none. No checks while paused.");
    const resume = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Resume the recipe",
    )!;
    await act(async () => resume.click());
    expect(onAction).toHaveBeenCalledWith(paused, "resume");
    expect(onWaitingAction).not.toHaveBeenCalled();
  });

  it("keeps an older service's wording, without claiming a decision outside the snapshot was recorded", async () => {
    await act(async () =>
      reactRoot.render(
        <BotFileRecipesPanel
          recipes={[
            recipe({ events: [event({ status: "needs-decision", approvalId: "approval-9" })] }),
          ]}
          approvals={[]}
          tasks={[]}
          onBrowse={vi.fn()}
          onCreate={vi.fn()}
          onEdit={vi.fn()}
          onAction={vi.fn()}
          onStart={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain(
      "This file's decision isn't in this view. Open it to see its current state.",
    );
    expect(container.textContent).not.toContain("Decision recorded");
  });
});
