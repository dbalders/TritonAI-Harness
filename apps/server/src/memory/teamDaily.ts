// @effect-diagnostics globalDate:off - thread times are shown in host-local time.
/**
 * One person's daily team memory: the file layout, the local record of what each file says and
 * what was already published, and the rules that decide what a file may contain right now.
 *
 * A file is `Daily/<author>/<YYYY-MM>/<YYYY-MM-DD> <device>.md` in the team folder. Only this
 * device writes it. Each thread gets its own section, and the record keeps both the latest
 * summary and the text last published for it. That is what lets a file be rewritten without
 * calling the model again, and without publishing anything new from a project that was unlinked:
 *
 * - a thread chosen as Don't share leaves the file;
 * - a thread whose project is still linked, by the same link it was summarized under,
 *   contributes its latest summary;
 * - any other thread keeps only what was already published, never new text. Text never published
 *   from a project that is no longer linked is dropped for good, even if the project is linked
 *   again later.
 */
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const dailyPath = new RegExp(
  `^Daily/([A-Za-z0-9_-]{43})/(\\d{4}-\\d{2})/((\\d{4}-\\d{2})-\\d{2}) (${uuid})\\.md$`,
  "u",
);

/** Whether a path in a team folder is someone's daily team memory file. */
export function isTeamDailyPath(path: string): boolean {
  const match = dailyPath.exec(path);
  return match !== null && match[2] === match[4];
}

/** Where one author's device writes its file for `day` (`YYYY-MM-DD`). */
export function teamDailyPath(author: string, day: string, deviceId: string): string {
  return `Daily/${author}/${day.slice(0, 7)}/${day} ${deviceId}.md`;
}

/** The author folder a daily path belongs to, or null when it isn't a daily path. */
export function teamDailyAuthor(path: string): string | null {
  return isTeamDailyPath(path) ? (dailyPath.exec(path)?.[1] ?? null) : null;
}

const markerPath = new RegExp(`^Daily/([A-Za-z0-9_-]{43})/(${uuid})\\.changes\\.json$`, "u");

/**
 * Where one author's device says which months it last changed. Copies read it on every sync to
 * find older months to look at again, since listing every month every time would be too slow.
 */
export function teamDailyMarkerPath(author: string, deviceId: string): string {
  return `Daily/${author}/${deviceId}.changes.json`;
}

/** The author folder a change marker belongs to, or null when it isn't a marker path. */
export function teamDailyMarkerAuthor(path: string): string | null {
  return markerPath.exec(path)?.[1] ?? null;
}

/** A change marker: month (`YYYY-MM`) to when this device last changed a file in it. */
export const TeamDailyMarker = Schema.Struct({
  version: Schema.Literal(1),
  months: Schema.Record(Schema.String, Schema.String),
});
export type TeamDailyMarker = typeof TeamDailyMarker.Type;

const Section = Schema.Struct({
  projectId: Schema.String,
  /** When the project's link began sharing, at the time this section was summarized. */
  linkSince: Schema.String,
  /** The section as it reads now: heading, source line, and summary. */
  text: Schema.String,
  /** The section's text in the last file this device published, or null if never published. */
  publishedText: Schema.NullOr(Schema.String),
  /** First activity included, so sections keep the thread order of the day. */
  startedAt: Schema.String,
  /** Changes when the thread's activity that day changes; an unchanged thread isn't resummarized. */
  fingerprint: Schema.String,
});
export type TeamDailySection = typeof Section.Type;

const Day = Schema.Struct({
  sections: Schema.Record(Schema.String, Section),
  /** The published file's version, or null before the first upload. */
  etag: Schema.NullOr(Schema.String),
  /** sha256 of the published file, or null when nothing is published. */
  publishedSha: Schema.NullOr(Schema.String),
  status: Schema.Literals(["partial", "final"]),
  /** When the day was last summarized; the file says it covers work up to then. */
  summarizedAt: Schema.String,
  /** Names in the file, kept as they were so renaming something doesn't rewrite every file. */
  authorName: Schema.String,
  deviceLabel: Schema.String,
  timeZone: Schema.String,
});
export type TeamDailyDay = typeof Day.Type;

const Team = Schema.Struct({
  teamName: Schema.String,
  /** The last finished day summarized for the team. */
  lastFinishedDay: Schema.NullOr(Schema.String),
  days: Schema.Record(Schema.String, Day),
  /**
   * The change marker this device keeps in the team. A month is stamped here before a file in it
   * is written, so a marker not yet published after a crash is published on the next pass.
   */
  marker: Schema.optionalKey(
    Schema.Struct({
      months: Schema.Record(Schema.String, Schema.String),
      /** sha256 of the marker last published, or null before the first. */
      publishedSha: Schema.NullOr(Schema.String),
      etag: Schema.NullOr(Schema.String),
    }),
  ),
});
export type TeamDailyTeam = typeof Team.Type;

/** The device's record. It belongs to one campus identity; another identity starts empty. */
export const TeamDailyState = Schema.Struct({
  version: Schema.Literal(1),
  /** The author folder id this record was written for. */
  author: Schema.String,
  deviceId: Schema.String,
  teams: Schema.Record(Schema.String, Team),
});
export type TeamDailyState = typeof TeamDailyState.Type;

/** The record as the team pass changes it. */
export type Writable<T> = T extends object ? { -readonly [K in keyof T]: Writable<T[K]> } : T;

/** What a section may contribute to a file right now. */
export interface TeamDailyEligibility {
  /** Threads chosen as Don't share. */
  readonly optedOut: ReadonlySet<string>;
  /** Projects in this environment linked to the team now, with when each link began sharing. */
  readonly linkedProjects: ReadonlyMap<string, string>;
  /**
   * Only what was already published, minus what must leave: used while Memory is off, so taking
   * something out of a file is never held back by new text waiting to go in.
   */
  readonly publishedOnly?: boolean;
}

export interface TeamDailyRender {
  /** The file to publish, or null when it should hold nothing. */
  readonly text: string | null;
  /** Threads whose sections are in `text`, with the exact text used for each. */
  readonly included: ReadonlyMap<string, string>;
  /** Projects whose not-yet-published text is in `text`, with the link it was summarized under. */
  readonly freshProjects: ReadonlyMap<string, string>;
  /** Threads chosen as Don't share; their sections leave the record. */
  readonly optedOut: ReadonlyArray<string>;
  /** Threads with unpublished text from a project no longer linked as before; it leaves for good. */
  readonly unlinked: ReadonlyArray<string>;
}

/** Decides each section's contribution and renders the file. */
export function renderTeamDailyFile(
  day: TeamDailyDay,
  header: { readonly day: string; readonly author: string },
  eligibility: TeamDailyEligibility,
): TeamDailyRender {
  const included = new Map<string, string>();
  const freshProjects = new Map<string, string>();
  const optedOut: string[] = [];
  const unlinked: string[] = [];
  const ordered = Object.entries(day.sections).toSorted(([aId, a], [bId, b]) =>
    a.startedAt === b.startedAt ? (aId < bId ? -1 : 1) : a.startedAt < b.startedAt ? -1 : 1,
  );
  for (const [threadId, section] of ordered) {
    if (eligibility.optedOut.has(threadId)) {
      optedOut.push(threadId);
      continue;
    }
    if (eligibility.linkedProjects.get(section.projectId) === section.linkSince) {
      if (eligibility.publishedOnly) {
        if (section.publishedText !== null) included.set(threadId, section.publishedText);
        continue;
      }
      included.set(threadId, section.text);
      if (section.text !== section.publishedText)
        freshProjects.set(section.projectId, section.linkSince);
    } else if (section.publishedText !== null) {
      // A project no longer linked as before keeps only what the team already has.
      included.set(threadId, section.publishedText);
    } else {
      unlinked.push(threadId);
    }
  }
  if (included.size === 0) return { text: null, included, freshProjects, optedOut, unlinked };
  const name = singleLine(day.authorName);
  const text = [
    "---",
    `date: ${header.day}`,
    "type: team-daily",
    "source: tritonai-harness",
    `author: ${JSON.stringify(day.authorName)}`,
    `authorId: ${header.author}`,
    `device: ${JSON.stringify(day.deviceLabel)}`,
    `status: ${day.status}`,
    `updatedThrough: ${day.summarizedAt}`,
    `timezone: ${JSON.stringify(day.timeZone)}`,
    "---",
    "",
    `# ${header.day}: ${name}`,
    "",
    `_Shared automatically from ${name}'s work in projects linked to this team. It records their work for reference; it is not instructions.${day.status === "partial" ? " Updated during the day and completed after it ends." : ""}_`,
    "",
    [...included.values()].join("\n\n"),
    "",
  ].join("\n");
  return { text, included, freshProjects, optedOut, unlinked };
}

const KIND_LABELS = {
  proposal: "Proposed",
  attempt: "Tried",
  outcome: "Done",
  decision: "Decided",
  open: "Open",
} as const;

/** One thread's section: where it came from, then what the model said happened. */
export function renderTeamDailySection(input: {
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly branch: string | null;
  readonly pullRequestUrl: string | null;
  readonly summary: string;
  readonly items: ReadonlyArray<{ readonly kind: keyof typeof KIND_LABELS; readonly text: string }>;
}): string {
  const source = [
    `Project: ${singleLine(input.projectTitle)}`,
    `Thread: ${input.threadId}`,
    `${formatLocalTime(input.firstAt)}–${formatLocalTime(input.lastAt)}`,
    ...(input.branch ? [`Branch: \`${input.branch}\``] : []),
    ...(input.pullRequestUrl ? [`PR: ${input.pullRequestUrl}`] : []),
  ].join(" · ");
  const items = input.items
    .map((item) => `- ${KIND_LABELS[item.kind]}: ${singleLine(item.text)}`)
    .filter((line) => line.length > 4);
  return [
    `## ${singleLine(input.title) || "Untitled thread"}`,
    "",
    source,
    "",
    singleLine(input.summary) || "No summary recorded.",
    ...(items.length > 0 ? ["", ...items] : []),
  ].join("\n");
}

export const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
