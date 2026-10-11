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
 * - a thread chosen as Don't share, or shared again since it was summarized, leaves the file;
 * - a thread that still exists in the same project, linked by the same link it was summarized
 *   under, contributes its latest summary;
 * - any other thread keeps only what was already published, never new text. Text never published
 *   from a thread that no longer qualifies is dropped for good, even if it qualifies again later.
 *
 * Each file has a size budget. New text that doesn't fit waits, and the file says so.
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

/** The largest daily file Harness writes, under the 64 KB limit on team documents. */
export const MAX_TEAM_DAILY_BYTES = 60_000;

const Section = Schema.Struct({
  projectId: Schema.String,
  /**
   * When the thread was last shared again after Don't share, at the time this section was
   * summarized; null if it never was. A later re-share makes the section stale.
   */
  sharing: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  /** The team folder the file was published to; a file is only ever updated there. */
  storageKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * A write whose outcome isn't known yet: recorded before each upload, so after a crash or an
   * unanswered request the next pass reads the file to learn whether it landed.
   */
  attempt: Schema.optionalKey(
    Schema.Struct({
      sha: Schema.NullOr(Schema.String),
      included: Schema.Record(Schema.String, Schema.String),
    }),
  ),
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
      /** The team folder the marker is in. */
      storageKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
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

/**
 * A thread as it stands now, deleted ones included: deleting a thread doesn't undo choosing Don't
 * share for it. Absent only when no record of the thread is left.
 */
export interface TeamDailyThreadNow {
  readonly projectId: string;
  readonly deleted: boolean;
  readonly off: boolean;
  readonly resumedAt: string | null;
}

/** What a section may contribute to a file right now. */
export interface TeamDailyEligibility {
  readonly threads: ReadonlyMap<string, TeamDailyThreadNow>;
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
  /** Threads whose not-yet-published text is in `text`, as each stood when it was summarized. */
  readonly freshThreads: ReadonlyMap<string, TeamDailyThreadNow>;
  /** Threads chosen as Don't share or shared again since; their sections leave the record. */
  readonly withdrawn: ReadonlyArray<string>;
  /** Threads whose unpublished text can never be published; it leaves the record for good. */
  readonly dropped: ReadonlyArray<string>;
  /** Threads that keep only their published text from now on. */
  readonly frozen: ReadonlyArray<string>;
  /** Threads whose new text waits because the file reached its size budget. */
  readonly deferred: ReadonlyArray<string>;
}

/** Whether a section is still the thread's current, shared work. */
const withdrawnNow = (section: TeamDailySection, now: TeamDailyThreadNow | undefined) =>
  now !== undefined && (now.off || now.resumedAt !== (section.sharing ?? null));

/** Decides each section's contribution and renders the file. */
export function renderTeamDailyFile(
  day: TeamDailyDay,
  header: { readonly day: string; readonly author: string },
  eligibility: TeamDailyEligibility,
): TeamDailyRender {
  const chosen = new Map<string, { text: string; fresh: boolean }>();
  const freshProjects = new Map<string, string>();
  const freshThreads = new Map<string, TeamDailyThreadNow>();
  const withdrawn: string[] = [];
  const dropped: string[] = [];
  const frozen: string[] = [];
  const deferred: string[] = [];
  const ordered = Object.entries(day.sections).toSorted(([aId, a], [bId, b]) =>
    a.startedAt === b.startedAt ? (aId < bId ? -1 : 1) : a.startedAt < b.startedAt ? -1 : 1,
  );
  for (const [threadId, section] of ordered) {
    const now = eligibility.threads.get(threadId);
    if (withdrawnNow(section, now)) {
      withdrawn.push(threadId);
      continue;
    }
    const current =
      now !== undefined &&
      !now.deleted &&
      now.projectId === section.projectId &&
      eligibility.linkedProjects.get(section.projectId) === section.linkSince;
    if (current) {
      if (eligibility.publishedOnly) {
        if (section.publishedText !== null)
          chosen.set(threadId, { text: section.publishedText, fresh: false });
        continue;
      }
      chosen.set(threadId, {
        text: section.text,
        fresh: section.text !== section.publishedText,
      });
    } else if (section.publishedText !== null) {
      // A thread that no longer qualifies keeps only what the team already has.
      chosen.set(threadId, { text: section.publishedText, fresh: false });
      if (section.text !== section.publishedText) frozen.push(threadId);
    } else {
      dropped.push(threadId);
    }
  }
  const name = singleLine(day.authorName);
  const renderWith = (texts: ReadonlyArray<string>, waiting: number) =>
    [
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
      texts.join("\n\n"),
      ...(waiting > 0
        ? [
            "",
            `_${waiting} more ${waiting === 1 ? "thread's" : "threads'"} latest work from this day ${waiting === 1 ? "isn't" : "aren't"} shown because this file reached its size limit._`,
          ]
        : []),
      "",
    ].join("\n");
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  // Start from what the team already has, which always stays: a published section's text is
  // its baseline even when it has newer text. New text then replaces a baseline, or adds a
  // thread, in order, while the whole file, header included, stays within the budget.
  const current = new Map<string, string | null>();
  for (const [threadId, entry] of chosen)
    current.set(
      threadId,
      entry.fresh ? (day.sections[threadId]!.publishedText ?? null) : entry.text,
    );
  const fileOf = (waiting: number) =>
    renderWith(
      [...current.values()].filter((text): text is string => text !== null),
      waiting,
    );
  const freshIds = [...chosen].filter(([, entry]) => entry.fresh).map(([threadId]) => threadId);
  const accepted = new Set<string>();
  for (const [index, threadId] of freshIds.entries()) {
    const baseline = current.get(threadId)!;
    current.set(threadId, chosen.get(threadId)!.text);
    // Room is kept for the note about what is still waiting after this thread.
    const waitingAfter = freshIds.length - index - 1;
    if (bytes(fileOf(waitingAfter + deferred.length)) <= MAX_TEAM_DAILY_BYTES) {
      accepted.add(threadId);
      continue;
    }
    current.set(threadId, baseline);
    deferred.push(threadId);
  }
  const included = new Map<string, string>();
  for (const [threadId, text] of current) {
    if (text === null) continue;
    included.set(threadId, text);
    if (accepted.has(threadId)) {
      const section = day.sections[threadId]!;
      freshProjects.set(section.projectId, section.linkSince);
      freshThreads.set(threadId, eligibility.threads.get(threadId)!);
    }
  }
  const result = { included, freshProjects, freshThreads, withdrawn, dropped, frozen, deferred };
  if (included.size === 0) return { text: null, ...result };
  return { text: fileOf(deferred.length), ...result };
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
    .slice(0, MAX_SECTION_ITEMS)
    .map((item) => `- ${KIND_LABELS[item.kind]}: ${clip(singleLine(item.text), 500)}`)
    .filter((line) => line.length > 4);
  return [
    `## ${singleLine(input.title) || "Untitled thread"}`,
    "",
    source,
    "",
    clip(singleLine(input.summary), 1_000) || "No summary recorded.",
    ...(items.length > 0 ? ["", ...items] : []),
  ].join("\n");
}

export const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const MAX_SECTION_ITEMS = 20;
const clip = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
