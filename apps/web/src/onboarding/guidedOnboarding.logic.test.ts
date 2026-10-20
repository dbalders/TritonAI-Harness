import type { IntegrationSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  GOOGLE_WORKSPACE_ID,
  MICROSOFT_365_ID,
  ONBOARDING_ROLES,
  accountTaskMessage,
  connectionAccess,
  fileTaskMessage,
  onboardingProgressLines,
  onboardingRole,
  onboardingTask,
  parseSampleTable,
  recommendedTaskId,
} from "./guidedOnboarding.logic";

describe("onboarding roles", () => {
  it("gives every role an account task, a file task with a sample, and one more account task", () => {
    for (const role of ONBOARDING_ROLES) {
      const [first, file, third] = role.tasks;
      expect(first.source).toBe("mail");
      expect(file.source).toBe("file");
      expect(file.sample?.contents.length).toBeGreaterThan(0);
      expect(["calendar", "teams"]).toContain(third.source);
    }
  });

  it("keeps first tasks read-only and drafts unsent", () => {
    for (const role of ONBOARDING_ROLES) {
      for (const task of role.tasks) {
        expect(task.prompt).toMatch(/Only read|don't change any files/);
        for (const followUp of task.followUps.filter((item) => item.kind === "draft")) {
          expect(followUp.prompt).toMatch(/don't save or send it/);
        }
      }
    }
  });

  it("never lets a repeated save replace a file it saved before", () => {
    for (const role of ONBOARDING_ROLES) {
      for (const task of role.tasks) {
        for (const followUp of task.followUps.filter((item) => item.kind === "save")) {
          expect(followUp.prompt).toContain("use a new name instead");
        }
      }
    }
  });

  it("falls back to the first role and finds tasks by id", () => {
    expect(onboardingRole(null).id).toBe("admin");
    const finance = onboardingRole("finance");
    expect(onboardingTask(finance, "finance-budget")?.source).toBe("file");
    expect(onboardingTask(finance, "missing")).toBeNull();
  });
});

describe("recommendedTaskId", () => {
  it("suggests their own email only once it is connected, and the sample file otherwise", () => {
    const role = onboardingRole("finance");
    expect(recommendedTaskId(role, true)).toBe("finance-approvals");
    expect(recommendedTaskId(role, false)).toBe("finance-budget");
  });
});

describe("task messages", () => {
  it("names the account it should read", () => {
    const [mail] = onboardingRole("finance").tasks;
    expect(accountTaskMessage(mail, MICROSOFT_365_ID)).toContain("in my Outlook");
    expect(accountTaskMessage(mail, GOOGLE_WORKSPACE_ID)).toContain("in my Gmail");
  });

  it("pastes the sample under the request, so the first answer needs no file access", () => {
    const budget = onboardingRole("finance").tasks[1];
    const message = fileTaskMessage(budget, { sample: true });
    expect(message).toMatch(/^Check the budget below: which lines are over budget/);
    expect(message).toContain("Budget.csv:\n```csv\nLine,Budget,Actual\nTravel,8000,10140");
    expect(message).not.toContain("{file}");
  });

  it("points at their own attached file by name", () => {
    const notes = onboardingRole("admin").tasks[1];
    expect(fileTaskMessage(notes, { attachedFileName: "Staff meeting.docx" })).toBe(
      'Turn the attached file "Staff meeting.docx" into a to-do list, with an owner and a date for each item. Answer here in the chat; don\'t change any files.',
    );
  });
});

const capability = (id: string, displayName: string, enabled: boolean) => ({
  id,
  displayName,
  description: displayName,
  access: enabled ? ("default" as const) : ("opt-in" as const),
  enabled,
  granted: enabled,
  available: enabled,
});

const tool = (name: string, capabilities: string[], effect: "read" | "write") => ({
  name,
  displayName: name,
  description: name,
  capabilities,
  effect,
  available: true,
});

describe("connectionAccess", () => {
  const outlook = (draftsOn: boolean) =>
    ({
      id: MICROSOFT_365_ID,
      capabilities: [
        capability("mail.read", "Read mail", true),
        capability("mail.draft.create", "Create mail drafts", draftsOn),
        capability("calendar.read", "Read calendars", true),
      ],
      tools: [
        tool("microsoft365.mail.search", ["mail.read"], "read"),
        tool("microsoft365.mail.draft.create", ["mail.draft.create"], "write"),
        tool("microsoft365.calendar.events", ["calendar.read"], "read"),
      ],
    }) as unknown as IntegrationSummary;

  it("lists what the plugin will really read, and nothing it isn't set to do", () => {
    expect(connectionAccess(outlook(false))).toEqual({
      reads: ["Read mail", "Read calendars"],
      writes: [],
    });
  });

  it("calls out write capabilities someone turned on in Settings", () => {
    expect(connectionAccess(outlook(true)).writes).toEqual(["Create mail drafts"]);
  });

  it("claims nothing without a plugin", () => {
    expect(connectionAccess(null)).toEqual({ reads: [], writes: [] });
  });
});

describe("onboardingProgressLines", () => {
  it("retells real plugin calls in plain words, once each, in order", () => {
    expect(
      onboardingProgressLines([
        { label: "Thinking" },
        { label: "Tool call", toolTitle: "microsoft365_mail_search", integrationTool: true },
        { label: "Tool call", toolTitle: "microsoft365.mail.get" },
        { label: "Tool call", toolTitle: "microsoft365_calendar_events", integrationTool: true },
        { label: "Tool call", toolTitle: "microsoft365_chat_messages", integrationTool: true },
        { label: "Tool call", toolTitle: "googleworkspace_drive_search", integrationTool: true },
      ]),
    ).toEqual([
      "Searching your email",
      "Reading your calendar",
      "Reading your Teams chats",
      "Looking through your files",
    ]);
  });

  it("names the file it reads and the files it saves", () => {
    expect(
      onboardingProgressLines([
        { label: "Ran command", command: 'cat "Staff notes.txt"' },
        { label: "Ran command", command: "/bin/zsh -lc \"sed -n '1,80p' 'Budget.csv'\"" },
        { label: "Ran command", command: "/bin/zsh -lc 'head -40 /tmp/uploads/abc/Ticket.md'" },
        { label: "Edited", changedFiles: ["/Users/me/TritonAI/Budget check.csv"] },
      ]),
    ).toEqual([
      "Reading Staff notes.txt",
      "Reading Budget.csv",
      "Reading Ticket.md",
      "Saving Budget check.csv",
    ]);
  });

  it("claims nothing for activity it can't describe", () => {
    expect(
      onboardingProgressLines([
        { label: "Thinking" },
        { label: "File change", toolTitle: "File change" },
        { label: "Ran command", command: "python3 summarize.py" },
        { label: "Tool call", toolTitle: "messages_from_somewhere_else" },
      ]),
    ).toEqual([]);
  });
});

describe("parseSampleTable", () => {
  it("reads the sample budget as a table", () => {
    expect(parseSampleTable("Line,Budget\nTravel,8000\n")).toEqual([
      ["Line", "Budget"],
      ["Travel", "8000"],
    ]);
  });
});
