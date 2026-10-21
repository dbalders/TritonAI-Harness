// The experimental guided tour walks someone who has barely used AI through one real piece
// of work from their own kind of day, then hands them to the real chat with follow-ups to
// try. Everything here is plain data and pure functions, so the screens stay simple and
// the copy is easy to review in one place.

import type { IntegrationSummary } from "@t3tools/contracts";

export type OnboardingRoleId = "admin" | "research" | "teaching" | "finance" | "it" | "other";

/** Which account a task reads, or a file. */
export type OnboardingTaskSource = "mail" | "calendar" | "teams" | "file";

/** The email account the person picked to connect. */
export type OnboardingMailProvider = "microsoft-365" | "google-workspace";

export const MICROSOFT_365_ID = "microsoft-365" satisfies OnboardingMailProvider;
export const GOOGLE_WORKSPACE_ID = "google-workspace" satisfies OnboardingMailProvider;

export interface OnboardingFollowUp {
  /** Chip text. */
  readonly label: string;
  /** The message sent when the chip is clicked; it reads naturally in the conversation. */
  readonly prompt: string;
  /** "save" writes a file, which asks Allow/Deny first in the tour's Supervised chat. */
  readonly kind: "ask" | "draft" | "save";
}

export interface OnboardingSample {
  readonly fileName: string;
  readonly contents: string;
  /** Show the sample as a table (CSV) instead of plain text. */
  readonly table?: boolean;
  /** How the prompt refers to the sample once it is pasted below the request. */
  readonly noun: string;
}

export interface OnboardingTask {
  readonly id: string;
  readonly source: OnboardingTaskSource;
  /** Card title on the "Pick something to try first" step. */
  readonly title: string;
  /** Button that starts it, after connecting or picking a file. */
  readonly action: string;
  /**
   * The message sent to the assistant. It is what the person sees themselves "say", so
   * it reads naturally and quietly models a good request. `{account}` becomes "Outlook"
   * or "Gmail"; `{file}` becomes the sample or the file they attached.
   */
  readonly prompt: string;
  readonly sample?: OnboardingSample;
  /** "Which notes should it use?" on the file step. */
  readonly fileQuestion?: string;
  readonly followUps: ReadonlyArray<OnboardingFollowUp>;
}

export interface OnboardingRole {
  readonly id: OnboardingRoleId;
  readonly title: string;
  readonly description: string;
  /** Three first tasks: something it reads in an account, a file, and one more account task. */
  readonly tasks: readonly [OnboardingTask, OnboardingTask, OnboardingTask];
}

const READ_ONLY = "Only read. Don't change, move, draft or send anything.";
const ANSWER_HERE = "Answer here in the chat; don't change any files.";
const DRAFT_ONLY = "Show it to me here; don't save or send it.";
/** Repeating the tour must never replace a file it saved last time. */
const KEEP_EXISTING = "If a file with that name already exists, use a new name instead.";

const save = (label: string, fileName: string, what: string): OnboardingFollowUp => ({
  kind: "save",
  label,
  prompt: `Save ${what} as "${fileName}" in my TritonAI folder. ${KEEP_EXISTING}`,
});

const CALENDAR_WEEK: OnboardingTask = {
  id: "calendar-week",
  source: "calendar",
  title: "See what's on my calendar this week",
  action: "Show my week",
  prompt: `What's on my {account} calendar this week? Give me a short day-by-day summary and point out the busiest day and any free blocks. ${READ_ONLY}`,
  followUps: [
    { kind: "ask", label: "When am I free on Thursday?", prompt: "When am I free on Thursday?" },
    {
      kind: "ask",
      label: "Prep me for my next meeting",
      prompt:
        "Prep me for my next meeting: who's coming, what it's about, and anything in my email I should read first.",
    },
    {
      kind: "draft",
      label: "Draft a note to move one of these",
      prompt: `Draft a short note asking to move my busiest day's least important meeting to a free block. ${DRAFT_ONLY}`,
    },
  ],
};

const TEAMS_TODAY: OnboardingTask = {
  id: "teams-today",
  source: "teams",
  title: "Catch up on my Teams chats",
  action: "Catch me up",
  prompt: `Catch me up on my Teams chats from the last day. Group them by conversation, and point out anything that mentions me or asks me a question. ${READ_ONLY}`,
  followUps: [
    {
      kind: "ask",
      label: "Which ones need a reply from me?",
      prompt: "Which of these need a reply from me?",
    },
    {
      kind: "draft",
      label: "Draft a reply to the most urgent one",
      prompt: `Draft a short reply to the most urgent one. ${DRAFT_ONLY}`,
    },
    {
      kind: "ask",
      label: "Anything in my email about the same things?",
      prompt: "Is there anything in my email about the same topics?",
    },
  ],
};

const WAITING_ON_ME: OnboardingTask["followUps"] = [
  { kind: "ask", label: "Which one is most urgent?", prompt: "Which one is most urgent, and why?" },
  {
    kind: "draft",
    label: "Draft a reply to the first one",
    prompt: `Draft a short, friendly reply to the first one. ${DRAFT_ONLY}`,
  },
  save("Save this list as a to-do document", "Replies to send.md", "this list"),
];

const MEETING_NOTES = `ops sync tues: maria, dev, kim, jordan
- spring orientation rooms?? still not booked. kim checking
  price ctr vs. library
- new hire laptops: 3 arriving wk of 4/14, dev to image them,
  need by 4/18!!
- budget: travel line ~$2k over, jordan to look into it
- survey results: maria to summarize for dept mtg next thurs
- reminder: timesheets due fri
- next mtg: same time, maybe zoom
`;

const ABSTRACT = `Sleep fragmentation and memory decline in older adults: a four-year cohort study

Background: Fragmented sleep is common in later life and has been linked to cognitive decline, but long-term evidence is limited.
Methods: We followed 412 adults aged 60 to 80 for four years. Sleep was measured with wrist actigraphy each year, and memory with a standard word-list test.
Results: A higher sleep fragmentation index predicted a faster decline in memory scores (0.31 SD over four years), after adjusting for age, sex, education and depression.
Conclusions: Sleep continuity may be an early, modifiable risk factor for memory decline. Trials of sleep interventions are warranted.
`;

const FEEDBACK = `Midterm course feedback (anonymous)
- lectures move too fast in week 3
- loved the worked examples
- pls post slides before class
- labs were the best part honestly
- too fast when we did recursion
- more practice problems please
- office hours conflict with my lab section
- the worked examples are the only reason I get it
`;

const BUDGET = `Line,Budget,Actual
Travel,8000,10140
Supplies,12000,7300
Equipment,20000,19850
Software,5000,5200
Student wages,30000,22400
`;

const TICKET = `Ticket 4821 (priority: normal)
User: Jordan Lee, Student Affairs
Issue: Outlook crashes right after opening, since last week's update.
Tried so far:
- Restarted the computer: no change
- Started Outlook in safe mode: works fine
Add-ins installed: Zoom, Grammarly, Adobe PDF
Outlook version: 16.89
`;

const BUDGET_SAMPLE: OnboardingSample = {
  fileName: "Budget.csv",
  contents: BUDGET,
  table: true,
  noun: "the budget below",
};

export const ONBOARDING_ROLES: ReadonlyArray<OnboardingRole> = [
  {
    id: "admin",
    title: "Office & admin",
    description: "Email, scheduling, meetings",
    tasks: [
      {
        id: "admin-waiting",
        source: "mail",
        title: "Find emails that are waiting on a reply from me",
        action: "Find them",
        prompt: `Find emails in my {account} from the last 7 days that are waiting on a reply from me. List each one with who sent it, when, and what they need. ${READ_ONLY}`,
        followUps: WAITING_ON_ME,
      },
      {
        id: "admin-notes",
        source: "file",
        title: "Turn meeting notes into a to-do list",
        action: "Make the to-do list",
        fileQuestion: "Which notes should it use?",
        sample: {
          fileName: "Team meeting notes.txt",
          contents: MEETING_NOTES,
          noun: "the meeting notes below",
        },
        prompt: `Turn {file} into a to-do list, with an owner and a date for each item. ${ANSWER_HERE}`,
        followUps: [
          { kind: "ask", label: "Which items have no date?", prompt: "Which items have no date?" },
          {
            kind: "draft",
            label: "Draft an email sending this to the team",
            prompt: `Draft a short email sending this list to the team. ${DRAFT_ONLY}`,
          },
          save("Save it as a document", "To-do list.md", "this to-do list"),
        ],
      },
      CALENDAR_WEEK,
    ],
  },
  {
    id: "research",
    title: "Research",
    description: "Papers, data, grants",
    tasks: [
      {
        id: "research-deadlines",
        source: "mail",
        title: "Find upcoming grant deadlines in my email",
        action: "Find deadlines",
        prompt: `Find grant, report and compliance deadlines mentioned in my {account} from the last 30 days. List each with the date, what's due and who it's from, soonest first. ${READ_ONLY}`,
        followUps: [
          {
            kind: "ask",
            label: "What does the soonest one need?",
            prompt: "What exactly does the soonest one need from me?",
          },
          {
            kind: "draft",
            label: "Draft a reply asking for the template",
            prompt: `Draft a short reply to the soonest one asking for the template or instructions. ${DRAFT_ONLY}`,
          },
          save("Save these dates as a list", "Deadlines.md", "these deadlines"),
        ],
      },
      {
        id: "research-paper",
        source: "file",
        title: "Summarize a paper",
        action: "Summarize it",
        fileQuestion: "Which paper should it summarize?",
        sample: {
          fileName: "Sleep study abstract.txt",
          contents: ABSTRACT,
          noun: "the abstract below",
        },
        prompt: `Summarize {file} in three plain sentences: what they did, what they found, and why it matters. ${ANSWER_HERE}`,
        followUps: [
          {
            kind: "ask",
            label: "What are the limitations?",
            prompt: "What are the limitations?",
          },
          {
            kind: "ask",
            label: "Explain it like I'm new to the field",
            prompt: "Explain it like I'm new to the field.",
          },
          save("Save the summary as a document", "Paper summary.md", "the summary"),
        ],
      },
      CALENDAR_WEEK,
    ],
  },
  {
    id: "teaching",
    title: "Teaching",
    description: "Courses, feedback, students",
    tasks: [
      {
        id: "teaching-students",
        source: "mail",
        title: "Sort this week's student emails by topic",
        action: "Sort them",
        prompt: `Look at the emails from students in my {account} this week and group them by topic, with a count for each and who asked. ${READ_ONLY}`,
        followUps: [
          {
            kind: "ask",
            label: "Who asked for an extension?",
            prompt: "Who asked for an extension, and why?",
          },
          {
            kind: "draft",
            label: "Draft one reply that answers the biggest group",
            prompt: `Draft one short announcement that answers the biggest group's question. ${DRAFT_ONLY}`,
          },
          save("Save this as a document", "Student questions.md", "this summary"),
        ],
      },
      {
        id: "teaching-feedback",
        source: "file",
        title: "Find themes in course feedback",
        action: "Find the themes",
        fileQuestion: "Which feedback should it read?",
        sample: {
          fileName: "Midterm feedback.txt",
          contents: FEEDBACK,
          noun: "the course feedback below",
        },
        prompt: `Find the main themes in {file}, how many comments mention each, and one or two small changes I could make. ${ANSWER_HERE}`,
        followUps: [
          {
            kind: "ask",
            label: "What do students like most?",
            prompt: "What do students like most?",
          },
          {
            kind: "draft",
            label: "Draft a note to the class about changes",
            prompt: `Draft a short note to the class about one change I'll make based on this. ${DRAFT_ONLY}`,
          },
          save("Save the themes as a document", "Feedback themes.md", "these themes"),
        ],
      },
      CALENDAR_WEEK,
    ],
  },
  {
    id: "finance",
    title: "Finance & purchasing",
    description: "Budgets, invoices, approvals",
    tasks: [
      {
        id: "finance-approvals",
        source: "mail",
        title: "Find approval requests from the last 7 days",
        action: "Find approval requests",
        prompt: `Find approval requests in my {account} from the last 7 days: requisitions, invoices and reimbursements. List each with the amount, who sent it and when, oldest first. ${READ_ONLY}`,
        followUps: [
          {
            kind: "ask",
            label: "Show me the oldest one",
            prompt: "Tell me more about the oldest one.",
          },
          {
            kind: "draft",
            label: "Draft a reply asking for missing details",
            prompt: `Draft a short reply to the one that's missing information, asking for what's needed. ${DRAFT_ONLY}`,
          },
          save("Put these in a spreadsheet", "Approvals.csv", "these as a spreadsheet"),
        ],
      },
      {
        id: "finance-budget",
        source: "file",
        title: "Check a budget for overages",
        action: "Check the budget",
        fileQuestion: "Which budget should it check?",
        sample: BUDGET_SAMPLE,
        prompt: `Check {file}: which lines are over budget, by how much, and as a percentage? ${ANSWER_HERE}`,
        followUps: [
          {
            kind: "ask",
            label: "Which line has the most left?",
            prompt: "Which line has the most left?",
          },
          {
            kind: "ask",
            label: "Write a two-line summary for my director",
            prompt: "Write a two-line summary of this for my director.",
          },
          save(
            "Save this as a new spreadsheet",
            "Budget check.csv",
            'the budget with a "Difference" column',
          ),
        ],
      },
      CALENDAR_WEEK,
    ],
  },
  {
    id: "it",
    title: "IT & technical",
    description: "Tickets, docs, scripts",
    tasks: [
      {
        id: "it-alerts",
        source: "mail",
        title: "Summarize alert emails from the last 24 hours",
        action: "Summarize alerts",
        prompt: `Summarize the alert and monitoring emails in my {account} from the last 24 hours. Group them by issue, and say which are still happening. ${READ_ONLY}`,
        followUps: [
          {
            kind: "ask",
            label: "Which one should I look at first?",
            prompt: "Which one should I look at first, and why?",
          },
          {
            kind: "draft",
            label: "Draft a status update for the team",
            prompt: `Draft a short status update for my team about these. ${DRAFT_ONLY}`,
          },
          save("Save this as an incident note", "Alert summary.md", "this"),
        ],
      },
      {
        id: "it-ticket",
        source: "file",
        title: "Explain a support ticket and suggest next steps",
        action: "Explain it",
        fileQuestion: "Which ticket should it look at?",
        sample: { fileName: "Ticket 4821.txt", contents: TICKET, noun: "the support ticket below" },
        prompt: `Look at {file}. What's the likely cause, and what should I try next? ${ANSWER_HERE}`,
        followUps: [
          {
            kind: "ask",
            label: "Write the steps for the user",
            prompt: "Write the steps for the user in plain language.",
          },
          {
            kind: "ask",
            label: "What if that doesn't fix it?",
            prompt: "What should I try if that doesn't fix it?",
          },
          save("Save this as a how-to", "Outlook crash fix.md", "the steps"),
        ],
      },
      TEAMS_TODAY,
    ],
  },
  {
    id: "other",
    title: "A mix of things",
    description: "Show me a bit of everything",
    tasks: [
      {
        id: "other-waiting",
        source: "mail",
        title: "Find emails that are waiting on a reply from me",
        action: "Find them",
        prompt: `Find emails in my {account} from the last 7 days that are waiting on a reply from me. List each one with who sent it, when, and what they need. ${READ_ONLY}`,
        followUps: WAITING_ON_ME,
      },
      {
        id: "other-budget",
        source: "file",
        title: "Check a spreadsheet for problems",
        action: "Check it",
        fileQuestion: "Which spreadsheet should it check?",
        sample: BUDGET_SAMPLE,
        prompt: `Check {file}: which lines are over budget, by how much, and as a percentage? ${ANSWER_HERE}`,
        followUps: [
          {
            kind: "ask",
            label: "Which line has the most left?",
            prompt: "Which line has the most left?",
          },
          {
            kind: "ask",
            label: "Explain this to me like a manager",
            prompt: "Explain this to me in two sentences, the way I'd tell a manager.",
          },
          save(
            "Save a copy with the differences",
            "Budget check.csv",
            'the budget with a "Difference" column',
          ),
        ],
      },
      TEAMS_TODAY,
    ],
  },
];

export function onboardingRole(id: OnboardingRoleId | null): OnboardingRole {
  return ONBOARDING_ROLES.find((role) => role.id === id) ?? ONBOARDING_ROLES[0]!;
}

export function onboardingTask(role: OnboardingRole, taskId: string | null): OnboardingTask | null {
  return role.tasks.find((task) => task.id === taskId) ?? null;
}

/** Teams chats come only with Microsoft 365. */
export function taskNeedsMicrosoft(task: OnboardingTask): boolean {
  return task.source === "teams";
}

export function taskNeedsAccount(task: OnboardingTask): boolean {
  return task.source !== "file";
}

/**
 * The task to suggest first: their own account when it is already connected, otherwise
 * the file task, which gives a first answer in seconds without signing in to anything.
 */
export function recommendedTaskId(role: OnboardingRole, accountConnected: boolean): string {
  return (accountConnected ? role.tasks[0] : role.tasks[1]).id;
}

export function accountName(provider: OnboardingMailProvider): string {
  return provider === GOOGLE_WORKSPACE_ID ? "Gmail" : "Outlook";
}

/** The message for an account task, filled in for the account it reads. */
export function accountTaskMessage(task: OnboardingTask, provider: OnboardingMailProvider): string {
  return task.prompt.replaceAll("{account}", accountName(provider));
}

/**
 * The message for a file task. The sample is pasted under the request, so the first
 * answer needs no file access, approval or folder; their own file goes as an attachment.
 */
export function fileTaskMessage(
  task: OnboardingTask,
  input: { readonly sample: true } | { readonly attachedFileName: string },
): string {
  if ("sample" in input) {
    const sample = task.sample;
    if (!sample) return task.prompt.replaceAll("{file}", "the attached file");
    const fence = sample.table ? "```csv" : "```";
    return `${task.prompt.replaceAll("{file}", sample.noun)}\n\n${sample.fileName}:\n${fence}\n${sample.contents.trimEnd()}\n\`\`\``;
  }
  return task.prompt.replaceAll("{file}", `the attached file "${input.attachedFileName}"`);
}

/** The plugin capability an account task reads with; both plugins use the same ids. */
function taskCapability(task: OnboardingTask): string | null {
  switch (task.source) {
    case "mail":
      return "mail.read";
    case "calendar":
      return "calendar.read";
    case "teams":
      return "chat.read";
    default:
      return null;
  }
}

/** Whether a signed-in plugin can do what this task needs: its capability is on and active. */
export function integrationCanRunTask(
  integration: IntegrationSummary | null,
  task: OnboardingTask,
): boolean {
  const capabilityId = taskCapability(task);
  if (capabilityId === null) return true;
  const capability = integration?.capabilities.find((item) => item.id === capabilityId);
  return capability !== undefined && capability.enabled && capability.available;
}

/** What a sign-in lets TritonAI do, from the plugin's own enabled capabilities. */
export interface ConnectionAccess {
  readonly reads: ReadonlyArray<string>;
  /** Write capabilities someone turned on in Settings; plugin writes still ask first. */
  readonly writes: ReadonlyArray<string>;
}

export function connectionAccess(integration: IntegrationSummary | null): ConnectionAccess {
  if (!integration) return { reads: [], writes: [] };
  const reads: string[] = [];
  const writes: string[] = [];
  for (const capability of integration.capabilities) {
    if (!capability.enabled) continue;
    const writesData = integration.tools.some(
      (tool) => tool.effect === "write" && tool.capabilities.includes(capability.id),
    );
    (writesData ? writes : reads).push(capability.displayName);
  }
  return { reads, writes };
}

// ---------------------------------------------------------------------------------
// Live progress: the chat's work log, retold in plain words while the first answer is
// on its way. Only things that really happened are described.

/** The parts of a chat work-log entry the progress view reads. */
export interface OnboardingWorkLogEntry {
  readonly label: string;
  readonly toolTitle?: string | undefined;
  readonly command?: string | undefined;
  readonly changedFiles?: ReadonlyArray<string> | undefined;
  /** The call went to a plugin, such as Microsoft 365 or Google Workspace. */
  readonly integrationTool?: boolean | undefined;
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const PLUGIN_TOOL_NAME = /^(microsoft365|googleworkspace)[._]/i;
const FILE_READ_COMMAND = /(^|[\s;&|"'(])(cat|head|tail|sed|nl|less|rg|grep|wc|get-content)\s/i;

/** A quoted file name, or else a bare path with an extension, in a shell command. */
function fileNamedIn(command: string): string | null {
  const quoted = /"([^"]+\.[a-z0-9]{2,5})"|'([^']+\.[a-z0-9]{2,5})'/i.exec(command);
  if (quoted) return quoted[1] ?? quoted[2] ?? null;
  return /(?:^|[\s'"])([^\s'"]+\.[a-z0-9]{2,5})(?=$|[\s'"])/i.exec(command)?.[1] ?? null;
}

/** One plain-language line per kind of thing it has done so far, in order, without repeats. */
export function onboardingProgressLines(
  entries: ReadonlyArray<OnboardingWorkLogEntry>,
): ReadonlyArray<string> {
  const lines: string[] = [];
  const add = (line: string) => {
    if (!lines.includes(line)) lines.push(line);
  };
  for (const entry of entries) {
    if (entry.changedFiles && entry.changedFiles.length > 0) {
      for (const path of entry.changedFiles) add(`Saving ${baseName(path)}`);
      continue;
    }
    const tool = entry.toolTitle ?? "";
    if (entry.integrationTool || PLUGIN_TOOL_NAME.test(tool)) {
      // Plugin tools are named like "microsoft365.mail.search" (or with underscores).
      const words = ` ${tool} ${entry.label} `.toLowerCase().replace(/[._-]/g, " ");
      if (/\s(chat|chats|teams)\s/.test(words)) add("Reading your Teams chats");
      else if (/\s(calendar|calendars|events?)\s/.test(words)) add("Reading your calendar");
      else if (/\s(mail|gmail)\s/.test(words)) add("Searching your email");
      else if (/\s(files?|drive|onedrive|docs|sheets|slides)\s/.test(words))
        add("Looking through your files");
      continue;
    }
    if (entry.command && FILE_READ_COMMAND.test(entry.command)) {
      const file = fileNamedIn(entry.command);
      add(file ? `Reading ${baseName(file)}` : "Reading the file");
    }
  }
  return lines;
}

/** Rows of a small CSV sample for the preview table. Quotes and commas inside cells are not used. */
export function parseSampleTable(contents: string): ReadonlyArray<ReadonlyArray<string>> {
  return contents
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));
}
