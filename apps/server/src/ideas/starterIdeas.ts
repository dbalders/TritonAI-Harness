/**
 * Ready-made ideas for when there is not enough of the user's own work to go
 * on. Each prompt is complete: it can be sent as written, with nothing to fill
 * in and nothing the agent has to ask for first. An idea that needs a plugin
 * names it and is only offered once that plugin is connected.
 */
export interface StarterIdea {
  readonly id: string;
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  readonly prompt: string;
  /** A plugin id that must be connected before this idea can run. */
  readonly requires?: string;
}

// Plugin ideas come first, so a user with connected tools sees those before the general ones.
export const STARTER_IDEAS: ReadonlyArray<StarterIdea> = [
  {
    id: "m365-inbox-sort",
    requires: "microsoft-365",
    icon: "📬",
    title: "Sort your recent email into what needs a reply",
    body: "I'll read the last three days of your Microsoft 365 mail and split it into needs a reply, waiting on others, and FYI. Nothing gets moved or sent.",
    prompt:
      "Look through my Microsoft 365 email from the last three days. Group it into three lists: needs my reply, waiting on someone else, and FYI. For each item give the sender, a one-line summary, and any deadline it mentions. Don't reply to, move, or change anything.",
  },
  {
    id: "m365-next-meeting-brief",
    requires: "microsoft-365",
    icon: "🗓️",
    title: "Prepare a brief for your next meeting",
    body: "I'll find your next meeting, read its details and related email, and write a one-page brief with open questions and points to raise.",
    prompt:
      "Find my next meeting on my Microsoft 365 calendar. Read its description and attachments, and search my email from the last month for messages from its attendees on the same subject. Then write a one-page brief: the meeting's purpose, what has been said so far, open questions, and three points I could raise. Don't contact anyone or change the event.",
  },
  {
    id: "m365-week-ahead",
    requires: "microsoft-365",
    icon: "📆",
    title: "Look over your week and flag conflicts",
    body: "I'll check the next seven days of your calendar for double-bookings, back-to-back days, and meetings with no agenda, then point out your best focus time.",
    prompt:
      "Review my Microsoft 365 calendar for the next seven days. Point out double-bookings, days with no break longer than 30 minutes, and meetings with no description or agenda. Then tell me which open blocks are best for focused work. Don't change any events.",
  },
  {
    id: "github-open-work",
    requires: "github",
    icon: "🐙",
    title: "Summarize what's waiting on you in GitHub",
    body: "I'll list your open pull requests and assigned issues, and put the ones waiting on you first: review requests, failing checks, and unanswered comments.",
    prompt:
      "Using my connected GitHub account, list my open pull requests and the open issues assigned to me. For each one, say what it is about, when it last changed, and whether it is waiting on me because of a review request, failing checks, or an unanswered comment. Put the ones waiting on me first. Don't change anything.",
  },
  {
    id: "jira-my-tickets",
    requires: "jira-data-center",
    icon: "🎫",
    title: "Summarize your open Jira tickets",
    body: "I'll gather the UC San Diego Jira issues assigned to you, flag overdue or quiet ones, and suggest the three to work on first.",
    prompt:
      "Using UC San Diego Jira, find the open issues assigned to me. Group them by status, flag any that are overdue or haven't been updated in two weeks, and suggest which three to work on first and why. Don't change any issues.",
  },
  {
    id: "n8n-recent-failures",
    requires: "n8n",
    icon: "🔧",
    title: "Check your n8n workflows for recent failures",
    body: "I'll look at the last week of workflow runs and explain any failures in plain language, with a likely fix for each. Nothing gets changed or rerun.",
    prompt:
      "Using my connected n8n, look at workflow executions from the last seven days. List any workflows that failed, with when it happened, the step that failed, and the error in plain language. Suggest a likely fix for each, but don't change or rerun any workflow.",
  },
  {
    id: "google-drive-catch-up",
    requires: "google-workspace",
    icon: "🗂️",
    title: "Catch up on recent Google Drive changes",
    body: "I'll find the documents, sheets, and slides changed in the last week and summarize each in a line. Nothing gets edited or shared.",
    prompt:
      "Search my Google Drive for documents, spreadsheets, and slide decks changed in the last seven days. For each, say what it is, who changed it if Drive shows that, and a one-line summary of its contents. Don't edit, move, or share anything.",
  },
  {
    id: "tour-of-my-setup",
    icon: "🧭",
    title: "See five things TritonAI can do with your setup",
    body: "I'll look at your projects, plugins, and skills, then show five tasks I could do for you right now, each written as a request you can send.",
    prompt:
      "Give me a short tour of what you can do for me in TritonAI. Look at the projects I have and the plugins and skills that are turned on, then show me five specific tasks you could do right now, each written as a request I could send you. Keep it friendly and under 300 words.",
  },
  {
    id: "better-requests",
    icon: "✍️",
    title: "Learn how to get better answers from TritonAI",
    body: "Five short before-and-after examples of a vague request rewritten into a clear one, covering email, documents, spreadsheets, planning, and research.",
    prompt:
      "Teach me how to get better results from TritonAI. Show five short before-and-after examples of a vague request rewritten into a clear one, covering email, documents, spreadsheets, planning, and research. After each, explain in one sentence what made the rewrite better.",
  },
  {
    id: "sample-data-charts",
    icon: "📊",
    title: "See what TritonAI can do with a spreadsheet",
    body: "I'll make a small sample dataset, chart it two ways, and explain how you'd ask for the same thing with your own data.",
    prompt:
      "Create a small sample dataset of twelve months of made-up help desk tickets by category and save it as a CSV file in this project. Then make two charts from it, tickets per month and the share by category, and save them next to it. Explain what each chart shows and how I would ask you for the same thing with my own spreadsheet.",
  },
  {
    id: "focus-timer-page",
    icon: "⏱️",
    title: "Build a focus timer you can open in your browser",
    body: "A single web page with a 25-minute timer, breaks, and large readable controls that work with a keyboard and screen reader.",
    prompt:
      "Build a simple 25-minute focus timer as a single web page I can open in my browser. Include start, pause, and reset buttons, a five-minute break after each session, and large, readable text that works with a keyboard and a screen reader. Save it in this project and tell me how to open it.",
  },
  {
    id: "status-report-template",
    icon: "🗒️",
    title: "Make a reusable weekly status report",
    body: "A one-page template with highlights, progress, blockers, help needed, and next week's priorities, filled in with an example so it's easy to copy.",
    prompt:
      "Create a one-page weekly status report template and save it as a document in this project. Include sections for highlights, progress on goals, risks or blockers, help needed, and next week's priorities, with a one-line hint under each heading. Below the template, add a filled-in example for a made-up campus IT project so I can see how each section is used.",
  },
  {
    id: "email-templates",
    icon: "✉️",
    title: "Write five email templates you'll reuse",
    body: "Short, friendly drafts for following up, declining a meeting, asking for more time, introducing two people, and saying thanks.",
    prompt:
      "Write five short, friendly email templates I can reuse at work: following up on an unanswered request, politely declining a meeting, asking for a deadline extension, introducing two colleagues, and thanking someone for their help. Keep each under 120 words and use a clearly marked name or date wherever I would personalize it.",
  },
  {
    id: "project-plan-example",
    icon: "🗺️",
    title: "Set up a simple project plan you can copy",
    body: "A one-page brief, a task list with owners and dates, and a risks list, filled in with an example so you can see how each part works.",
    prompt:
      "Create a simple project plan in this project: a one-page brief with the goal, scope, people involved, and how we'll know it worked; a task list with owners and due dates; and a short list of risks. Fill it in with a realistic example for planning a department open house so I can see how each part is used.",
  },
  {
    id: "how-ai-works",
    icon: "💡",
    title: "Learn what TritonAI is good at and where it slips up",
    body: "A plain-language guide to how AI assistants work, when to trust them, and how to check their work, with a short list of do's and don'ts.",
    prompt:
      "Explain in plain language how an AI assistant like you works: what you're good at, where you make mistakes, why you can sound confident when you're wrong, and how I should check your work. Keep it under 400 words and end with a short list of do's and don'ts.",
  },
  {
    id: "accessible-documents",
    icon: "♿",
    title: "Learn how to make documents accessible",
    body: "A one-page guide to headings, alt text, link text, color contrast, and reading order, with an example for each and a checklist.",
    prompt:
      "Write a one-page guide to making a Word document or slide deck accessible. Cover headings, alt text, link text, color contrast, and reading order, with one quick example for each, and end with a five-item checklist I can use before sharing a file.",
  },
  {
    id: "workshop-signup-page",
    icon: "📝",
    title: "Build a sign-up form page in a few minutes",
    body: "A sample sign-up page for a campus workshop with clear labels and a confirmation message, so you can see how quickly a form comes together.",
    prompt:
      "Build a simple sign-up form web page for a made-up campus workshop with fields for name, email, department, and dietary needs, clear labels, helpful error messages, and a confirmation message. It doesn't need to send data anywhere. Save it in this project and tell me how to open it.",
  },
  {
    id: "office-tasks-to-hand-off",
    icon: "🤝",
    title: "List office tasks you could hand off to TritonAI",
    body: "Ten everyday campus office tasks I can help with, each with a ready-to-send example request.",
    prompt:
      "List ten everyday tasks in a university department office that you can help with, such as summarizing email, preparing meeting briefs, or cleaning up spreadsheets. For each, give one sentence on how you would help and an example request I could send you.",
  },
];

/** The ready-made ideas the user can run now: general ones, plus those whose plugin is connected. */
export function availableStarters(
  connectedPluginIds: ReadonlySet<string>,
): ReadonlyArray<StarterIdea> {
  return STARTER_IDEAS.filter(
    (starter) => starter.requires === undefined || connectedPluginIds.has(starter.requires),
  );
}

/**
 * Kinds of help the generator can draw on. They are not cards: the model must
 * turn one into an idea about a real thread, note, file, or connected tool.
 */
export const IDEA_KINDS: ReadonlyArray<string> = [
  "turn meeting notes into a follow-up email",
  "clean up a messy spreadsheet and explain it",
  "answer questions about a long document",
  "turn a list of tasks into a realistic plan",
  "automate a repetitive task",
  "make a tricky email clearer and kinder",
  "summarize a long email chain",
  "draft an agenda for an upcoming meeting",
  "turn a table of numbers into a chart",
  "write a spreadsheet formula",
  "compare options side by side",
  "outline a presentation",
  "find the themes in survey responses",
  "write step-by-step instructions for a process",
  "explain a confusing topic in plain language",
  "proofread a document and explain the fixes",
  "build a simple web page or form",
  "index or tidy a folder of files",
  "answer a question about a data file",
  "turn a long procedure into a checklist",
  "summarize a report for busy readers",
  "combine two spreadsheets",
  "check a document or page for accessibility",
  "plan a project timeline",
  "turn common questions into an FAQ",
  "pull a table out of a PDF",
  "write a one-page decision memo",
  "review code for bugs and confusing parts",
  "explain what a project folder contains",
  "write alt text for images",
  "replace jargon with plain words",
];
