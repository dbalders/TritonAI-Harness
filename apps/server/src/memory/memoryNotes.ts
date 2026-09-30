// @effect-diagnostics globalDate:off - thread times are shown in host-local time.
/**
 * Markdown for the general memory vault.
 *
 * Notes use Obsidian wiki links so the vault opens cleanly in Obsidian, but
 * everything is plain Markdown that any editor or agent can read. The model
 * only supplies prose; links, thread lists, and file names are built here so
 * they always point at real notes.
 */
import type { DailyMemoryGenerationResult } from "../textGeneration/TextGeneration.ts";

const HARNESS_NOTE_SOURCE = "tritonai-harness";

const USER_MESSAGE_LIMIT = 2_000;
const AGENT_MESSAGE_LIMIT = 3_000;
const THREAD_ACTIVITY_LIMIT = 16_000;

export interface MemoryActivityMessage {
  readonly turnId: string | null;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface MemoryThreadActivity {
  readonly threadId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly pullRequestUrl: string | null;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly codexThreadId: string | null;
  readonly messages: ReadonlyArray<MemoryActivityMessage>;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)} [truncated]`;
}

/**
 * Keep what a summary needs: every user message, and only the last agent
 * message of each turn. Earlier agent messages in a turn are progress notes
 * that the final message supersedes.
 */
export function selectMemoryMessages(
  messages: ReadonlyArray<MemoryActivityMessage>,
): ReadonlyArray<MemoryActivityMessage> {
  // An agent message without a turn id has nothing to supersede it, so it is kept.
  const turnKey = (message: MemoryActivityMessage, index: number) =>
    message.turnId ?? `message:${index}`;
  const lastAgentIndexByTurn = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      lastAgentIndexByTurn.set(turnKey(message, index), index);
    }
  });
  return messages.filter(
    (message, index) =>
      message.role === "user" || lastAgentIndexByTurn.get(turnKey(message, index)) === index,
  );
}

function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The thread activity section of the summary prompt. */
export function formatMemoryActivity(
  threads: ReadonlyArray<MemoryThreadActivity>,
  /** Project id to note name; the model reports work under these names. */
  projectNoteNames: ReadonlyMap<string, string>,
): string {
  return threads
    .map((thread) => {
      const header = [
        `## Thread: ${singleLine(thread.title)}`,
        `Project: ${projectNoteNames.get(thread.projectId) ?? thread.projectTitle}`,
        ...(thread.branch ? [`Branch: ${thread.branch}`] : []),
        ...(thread.pullRequestUrl ? [`Pull request: ${thread.pullRequestUrl}`] : []),
      ];
      const body = thread.messages.map((message) => {
        const speaker = message.role === "user" ? "User" : "Agent";
        const limit = message.role === "user" ? USER_MESSAGE_LIMIT : AGENT_MESSAGE_LIMIT;
        return `[${formatLocalTime(message.createdAt)}] ${speaker}: ${clip(message.text, limit)}`;
      });
      return clip([...header, "", ...body].join("\n"), THREAD_ACTIVITY_LIMIT);
    })
    .join("\n\n");
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/iu;

/**
 * A project note's file name, which is also its wiki link target. Drops
 * characters that break links or are invalid in Windows file names.
 */
export function projectNoteName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/u, "")
    .slice(0, 100)
    .trim();
  if (cleaned.length === 0) return "Untitled project";
  return WINDOWS_RESERVED_NAME.test(cleaned) ? `${cleaned} project` : cleaned;
}

/** The workspace a project note was written for, or null when it names none. */
export function projectNoteWorkspace(content: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  const line = frontmatter?.[1]!
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("workspace: "));
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line.slice("workspace: ".length));
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function bulletList(items: ReadonlyArray<string>, empty: string): string[] {
  const lines = items.map(singleLine).filter((item) => item.length > 0);
  return lines.length > 0 ? lines.map((item) => `- ${item}`) : [`- ${empty}`];
}

/**
 * How a device appears in file names, such as `MacBook Pro (3f2a)`. The short
 * code keeps two machines with the same name apart and makes every generated
 * file name unique across devices, so wiki links need no folder.
 */
export function deviceFileLabel(device: { readonly name: string; readonly shortId: string }) {
  return `${device.name} (${device.shortId})`;
}

/** A day note's file name without `.md`, which is also its wiki link target. */
export function dailyNoteName(day: string, deviceLabel: string): string {
  return `${day} ${deviceLabel}`;
}

/** A project note's file name without `.md`, which is also its wiki link target. */
export function projectNoteFileName(noteName: string, deviceLabel: string): string {
  return `${noteName} - ${deviceLabel}`;
}

export interface DailyNoteInput {
  readonly day: string;
  readonly deviceLabel: string;
  /** A note for today is partial until the day ends and it is written again. */
  readonly status: "partial" | "final";
  /** When the activity in a partial note was read, as an ISO time. */
  readonly updatedThrough: string;
  /** The IANA time zone that defined the day, such as `America/Los_Angeles`. */
  readonly timeZone: string;
  readonly summary: DailyMemoryGenerationResult;
  readonly threads: ReadonlyArray<MemoryThreadActivity>;
  /** Project id to note name. */
  readonly projectNoteNames: ReadonlyMap<string, string>;
  /** Codex thread id to its session file, when the file was found. */
  readonly sessionPaths: ReadonlyMap<string, string>;
  /** This device's previous day with a note. */
  readonly previousDay: string | null;
  /** Vault-relative paths of processed inbox notes, without `.md`. */
  readonly inboxLinks: ReadonlyArray<string>;
}

export function renderDailyNote(input: DailyNoteInput): string {
  const noteNames = [...new Set(input.projectNoteNames.values())];
  const noteNameByTitle = new Map<string, string>();
  for (const thread of input.threads) {
    const name = input.projectNoteNames.get(thread.projectId);
    if (name) noteNameByTitle.set(thread.projectTitle.trim().toLowerCase(), name);
  }
  for (const name of noteNames) noteNameByTitle.set(name.toLowerCase(), name);
  const projectLink = (noteName: string) =>
    `[[${projectNoteFileName(noteName, input.deviceLabel)}|${noteName}]]`;

  const workedOn = input.summary.projects.flatMap((entry) => {
    const noteName = noteNameByTitle.get(entry.project.trim().toLowerCase());
    const heading = noteName ? projectLink(noteName) : singleLine(entry.project) || "Other";
    return ["", `### ${heading}`, "", ...bulletList(entry.workedOn, "No details recorded.")];
  });

  const threadLines = input.threads.map((thread) => {
    const noteName = input.projectNoteNames.get(thread.projectId);
    const parts = [
      `**${singleLine(thread.title)}**`,
      noteName ? `in ${projectLink(noteName)}` : `in ${thread.projectTitle}`,
      ...(thread.branch ? [`on \`${thread.branch}\``] : []),
    ];
    const details: string[] = [];
    if (thread.pullRequestUrl) details.push(`Pull request: ${thread.pullRequestUrl}`);
    const sessionPath = thread.codexThreadId
      ? input.sessionPaths.get(thread.codexThreadId)
      : undefined;
    if (sessionPath) {
      details.push(`Session: \`${sessionPath}\``);
    } else if (thread.codexThreadId) {
      details.push(`Codex thread: \`${thread.codexThreadId}\``);
    }
    return `- ${parts.join(" ")}${details.length > 0 ? `. ${details.join(". ")}` : ""}`;
  });

  const links = [
    ...(input.previousDay
      ? [`- Previous day: [[${dailyNoteName(input.previousDay, input.deviceLabel)}]]`]
      : []),
    ...input.inboxLinks.map((link) => `- Inbox: [[${link}]]`),
  ];

  return [
    "---",
    `date: ${input.day}`,
    "type: daily",
    `source: ${HARNESS_NOTE_SOURCE}`,
    `device: ${JSON.stringify(input.deviceLabel)}`,
    `status: ${input.status}`,
    `updatedThrough: ${input.updatedThrough}`,
    `timezone: ${JSON.stringify(input.timeZone)}`,
    ...(noteNames.length > 0
      ? ["projects:", ...noteNames.map((name) => `  - ${JSON.stringify(name)}`)]
      : ["projects: []"]),
    "---",
    "",
    `# ${input.day} on ${input.deviceLabel}`,
    "",
    ...(input.status === "partial"
      ? ["_So far today. This note is updated during the day and completed after it ends._", ""]
      : []),
    singleLine(input.summary.overview) || "Summary unavailable.",
    "",
    "## Worked On",
    ...(workedOn.length > 0 ? workedOn : ["", "- No project work recorded."]),
    "",
    "## Decisions",
    "",
    ...bulletList(input.summary.decisions, "None recorded."),
    "",
    "## Open Loops",
    "",
    ...bulletList(input.summary.openLoops, "None recorded."),
    "",
    "## Threads",
    "",
    ...(threadLines.length > 0 ? threadLines : ["- None. This day only had inbox notes."]),
    ...(links.length > 0 ? ["", "## Links", "", ...links] : []),
    "",
  ].join("\n");
}

export function renderProjectNote(input: {
  readonly title: string;
  readonly workspaceRoot: string;
  readonly deviceLabel: string;
}): string {
  return [
    "---",
    "type: project",
    `source: ${HARNESS_NOTE_SOURCE}`,
    `device: ${JSON.stringify(input.deviceLabel)}`,
    `workspace: ${JSON.stringify(input.workspaceRoot)}`,
    "---",
    "",
    `# ${singleLine(input.title)} on ${input.deviceLabel}`,
    "",
    "Harness keeps this note up to date. Keep your own notes about the project in the `Notes` folder.",
    "",
    "## Recent",
    "",
  ].join("\n");
}

/**
 * Adds the day's history line under Recent, or replaces it when the day is
 * summarized again. A note without a Recent heading gets one at the end. Only
 * the Recent section, up to the next heading, is changed.
 */
export function appendProjectRecentLine(
  content: string,
  /** The day note's link target. */
  dailyNote: string,
  recent: string,
): string {
  const prefix = `- [[${dailyNote}]]:`;
  const line = `${prefix} ${singleLine(recent) || "Worked on this project."}`;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/u);
  const recentHeading = lines.findLastIndex((candidate) => candidate.trim() === "## Recent");
  if (recentHeading === -1) {
    const body = content.trimEnd();
    const gap = body.length > 0 ? newline + newline : "";
    return `${body}${gap}## Recent${newline}${newline}${line}${newline}`;
  }
  const nextHeading = lines.findIndex(
    (candidate, index) => index > recentHeading && /^#{1,6}\s/u.test(candidate),
  );
  const sectionEnd = nextHeading === -1 ? lines.length : nextHeading;
  const existing = lines.findIndex(
    (candidate, index) =>
      index > recentHeading && index < sectionEnd && candidate.startsWith(prefix),
  );
  if (existing !== -1) {
    lines[existing] = line;
    return lines.join(newline);
  }
  if (nextHeading === -1) {
    const separator = content.endsWith("\n") ? "" : newline;
    return `${content}${separator}${line}${newline}`;
  }
  // Recent is followed by the user's own section: insert at the end of Recent.
  const before = lines.slice(0, sectionEnd);
  while (before.length > recentHeading + 1 && before.at(-1)!.trim() === "") before.pop();
  if (before.length === recentHeading + 1) before.push("");
  return [...before, line, "", ...lines.slice(sectionEnd)].join(newline);
}
