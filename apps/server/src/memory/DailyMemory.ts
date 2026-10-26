import { getManagedCodexSettings } from "../managedPolicy.ts";
/**
 * DailyMemory - writes this device's daily notes into the general memory
 * vault. Reuse through Ideas and project history retains the host's provenance boundary.
 *
 * The summarizer remembers the last day it finished. On startup, every hour,
 * and when Memory is turned on, it summarizes each finished day after that
 * one, oldest first, and records each day only after its note is written. A
 * run that stops halfway resumes at the first unfinished day. Days without
 * thread activity or inbox notes are recorded without calling the model.
 *
 * Once every finished day is done, today's note is written too, and rewritten
 * at most every four hours while there is new activity. It stays partial until
 * the day ends and the final pass replaces it.
 */
import {
  type ServerMemoryStatus,
  type ServerProjectMemory,
  type ServerProjectMemoryInput,
  ServerProjectMemoryError,
  ThreadId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ExternalContent from "../integrations/ExternalContent.ts";
import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { addLocalDays, localDayAt, localDayRange, pendingMemoryDays } from "./memoryDays.ts";
import {
  appendProjectRecentLine,
  dailyNoteName,
  formatMemoryActivity,
  type MemoryActivityMessage,
  type MemoryThreadActivity,
  projectNoteFileName,
  projectNoteName,
  projectNoteWorkspace,
  renderDailyNote,
  renderProjectNote,
  selectMemoryMessages,
} from "./memoryNotes.ts";
import {
  type DevicePaths,
  devicePaths,
  ensureGeneralVault,
  findMemoryDevice,
  generalVaultPaths,
  type GeneralVaultPaths,
  type MemoryDevice,
  readPartialProgress,
  readSummaryProgress,
  registerMemoryDevice,
  removeGeneratedFile,
  removeMemorySkill,
  sha256Bytes,
  writeGeneratedFile,
  writePartialProgress,
  writeSummaryProgress,
} from "./memoryVault.ts";

const MAX_CATCH_UP_DAYS = 7;
const CHECK_INTERVAL = Duration.hours(1);
// Today's note is rewritten at most this often, and only when there is new input.
const PARTIAL_INTERVAL_MS = 4 * 60 * 60_000;
// Let startup work finish before the first check competes with it.
const STARTUP_DELAY = Duration.seconds(30);
const INBOX_NOTE_LIMIT = 8_000;
// A message still streaming after this long is treated as abandoned.
const STREAMING_GRACE_HOURS = 2;
// Stays under the prompt's inbox limit, so every note moved to processed was read.
const INBOX_PROMPT_LIMIT = 18_000;

interface SummarizerStatus {
  readonly state: "idle" | "summarizing" | "error";
  readonly message: string | null;
}

export class DailyMemory extends Context.Service<
  DailyMemory,
  {
    /** Runs one catch-up pass now. Safe to call while another pass runs; it waits. */
    readonly runCatchUp: Effect.Effect<void>;
    readonly getStatus: Effect.Effect<Omit<ServerMemoryStatus, "sync">>;
    readonly getProjectMemory: (
      input: ServerProjectMemoryInput,
    ) => Effect.Effect<ServerProjectMemory, ServerProjectMemoryError>;
    /** Runs `effect` while no catch-up pass is writing to the vault. */
    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/memory/DailyMemory") {}

interface ActivityRow {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly threadTitle: string;
  readonly branch: string | null;
  readonly linkedPullRequest: string | null;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly codexThreadId: string | null;
}

function pullRequestUrl(json: string | null): string | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" &&
      value !== null &&
      "url" in value &&
      typeof value.url === "string"
      ? value.url
      : null;
  } catch {
    return null;
  }
}

/** Threads with messages in `[startIso, endIso)`, in order of first activity. */
const loadDayActivity = Effect.fn("memory.loadDayActivity")(function* (range: {
  readonly startIso: string;
  readonly endIso: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ActivityRow>`
    SELECT
      m.thread_id AS "threadId",
      m.turn_id AS "turnId",
      m.role,
      m.text,
      m.created_at AS "createdAt",
      t.title AS "threadTitle",
      t.branch,
      t.linked_pull_request_json AS "linkedPullRequest",
      p.project_id AS "projectId",
      p.title AS "projectTitle",
      p.workspace_root AS "workspaceRoot",
      t.codex_thread_id AS "codexThreadId"
    FROM harness_activity_messages AS m
    JOIN harness_activity_threads AS t ON t.thread_id = m.thread_id
    JOIN projection_projects AS p ON p.project_id = t.project_id
    WHERE m.created_at >= ${range.startIso}
      AND m.created_at < ${range.endIso}
      AND m.is_streaming = 0
      AND m.role IN ('user', 'assistant')
      AND t.deleted_at IS NULL
      AND p.deleted_at IS NULL
    ORDER BY m.created_at ASC, m.message_id ASC
  `;

  const threads = new Map<
    string,
    { activity: MemoryThreadActivity; messages: MemoryActivityMessage[] }
  >();
  for (const row of rows) {
    let entry = threads.get(row.threadId);
    if (!entry) {
      entry = {
        activity: {
          threadId: row.threadId,
          title: row.threadTitle,
          branch: row.branch,
          pullRequestUrl: pullRequestUrl(row.linkedPullRequest),
          projectId: row.projectId,
          projectTitle: row.projectTitle,
          workspaceRoot: row.workspaceRoot,
          codexThreadId: typeof row.codexThreadId === "string" ? row.codexThreadId : null,
          messages: [],
        },
        messages: [],
      };
      threads.set(row.threadId, entry);
    }
    if (row.text.trim().length === 0) continue;
    entry.messages.push({
      turnId: row.turnId,
      role: row.role === "user" ? "user" : "assistant",
      text: row.text,
      createdAt: row.createdAt,
    });
  }
  return [...threads.values()]
    .map(({ activity, messages }) => ({ ...activity, messages: selectMemoryMessages(messages) }))
    .filter((thread) => thread.messages.length > 0);
});

/** Whether a message from the range is still being written and was updated since `sinceIso`. */
const hasStreamingMessages = Effect.fn("memory.hasStreamingMessages")(function* (
  range: { readonly startIso: string; readonly endIso: string },
  sinceIso: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly streaming: number }>`
    SELECT EXISTS (
      SELECT 1 FROM harness_activity_messages
      WHERE created_at >= ${range.startIso}
        AND created_at < ${range.endIso}
        AND is_streaming = 1
        AND updated_at >= ${sinceIso}
    ) AS "streaming"
  `;
  return Boolean(row?.streaming);
});

/**
 * Changes whenever a finished message in the range is added, edited, finished
 * late, or removed with its thread, so an unchanged day skips the model.
 */
const activityFingerprint = Effect.fn("memory.activityFingerprint")(function* (range: {
  readonly startIso: string;
  readonly endIso: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly count: number; readonly latest: string | null }>`
    SELECT COUNT(*) AS "count", MAX(m.updated_at) AS "latest"
    FROM harness_activity_messages AS m
    JOIN harness_activity_threads AS t ON t.thread_id = m.thread_id
    JOIN projection_projects AS p ON p.project_id = t.project_id
    WHERE m.created_at >= ${range.startIso}
      AND m.created_at < ${range.endIso}
      AND m.is_streaming = 0
      AND m.role IN ('user', 'assistant')
      AND t.deleted_at IS NULL
      AND p.deleted_at IS NULL
  `;
  return `${row?.count ?? 0}:${row?.latest ?? ""}`;
});

/** Maps Codex thread ids to their session files. Missing folders are skipped. */
const findSessionFiles = Effect.fn("memory.findSessionFiles")(function* (
  codexHome: string,
  codexThreadIds: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found = new Map<string, string>();
  if (codexThreadIds.size === 0) return found;
  for (const folder of ["sessions", "archived_sessions"]) {
    const root = path.join(codexHome, folder);
    const entries = yield* fs
      .readDirectory(root, { recursive: true })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of entries) {
      const name = path.basename(entry);
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      for (const id of codexThreadIds) {
        if (!found.has(id) && name.endsWith(`-${id}.jsonl`)) {
          found.set(id, path.join(root, entry));
        }
      }
    }
  }
  return found;
});

interface InboxNote {
  readonly fileName: string;
  readonly filePath: string;
  readonly content: string;
}

/** Notes directly in `directory` last changed before `beforeMs`. */
const readInboxNotes = Effect.fn("memory.readInboxNotes")(function* (
  directory: string,
  beforeMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const notes: InboxNote[] = [];
  for (const fileName of names.toSorted()) {
    if (!fileName.toLowerCase().endsWith(".md")) continue;
    const filePath = path.join(directory, fileName);
    const info = yield* fs.stat(filePath).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") continue;
    const modifiedMs = info.value.mtime._tag === "Some" ? info.value.mtime.value.getTime() : 0;
    if (modifiedMs >= beforeMs) continue;
    const content = yield* fs.readFileString(filePath).pipe(Effect.option);
    if (content._tag === "Some") notes.push({ fileName, filePath, content: content.value });
  }
  return notes;
});

interface InboxMove {
  readonly from: string;
  readonly to: string;
  /** Vault-relative wiki link target, without `.md`. */
  readonly link: string;
}

/** Chooses where each processed note goes under `Inbox/<short id>/processed/<day>/`. */
const planInboxMoves = Effect.fn("memory.planInboxMoves")(function* (
  vault: GeneralVaultPaths,
  device: DevicePaths,
  day: string,
  notes: ReadonlyArray<InboxNote>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetDirectory = path.join(device.processed, day);
  const taken = new Set<string>();
  const moves: InboxMove[] = [];
  for (const note of notes) {
    const stem = note.fileName.replace(/\.md$/iu, "");
    let targetName = `${stem}.md`;
    for (
      let attempt = 2;
      taken.has(targetName) || (yield* fs.exists(path.join(targetDirectory, targetName)));
      attempt++
    ) {
      targetName = `${stem}-${attempt}.md`;
    }
    taken.add(targetName);
    moves.push({
      from: note.filePath,
      to: path.join(targetDirectory, targetName),
      link: inboxLink(path, vault, path.join(targetDirectory, targetName)),
    });
  }
  return moves;
});

const applyInboxMoves = Effect.fn("memory.applyInboxMoves")(function* (
  moves: ReadonlyArray<InboxMove>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const move of moves) {
    yield* fs.makeDirectory(path.dirname(move.to), { recursive: true });
    yield* fs.rename(move.from, move.to);
  }
});

/** A processed inbox note's wiki link target: its vault-relative path without `.md`. */
function inboxLink(path: Path.Path, vault: GeneralVaultPaths, filePath: string): string {
  return path.relative(vault.root, filePath).split(path.sep).join("/").replace(/\.md$/iu, "");
}

/** This device's latest day note before `day`, across year folders. */
const previousDailyNote = Effect.fn("memory.previousDailyNote")(function* (
  vault: GeneralVaultPaths,
  device: MemoryDevice,
  day: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const suffix = ` ${device.label}.md`;
  const years = yield* fs
    .readDirectory(vault.daily)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const earlier: string[] = [];
  for (const year of years) {
    if (!/^\d{4}$/u.test(year) || year > day.slice(0, 4)) continue;
    const names = yield* fs
      .readDirectory(path.join(vault.daily, year))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of names) {
      if (!name.endsWith(suffix)) continue;
      const noteDay = name.slice(0, name.length - suffix.length);
      if (/^\d{4}-\d{2}-\d{2}$/u.test(noteDay) && noteDay < day) earlier.push(noteDay);
    }
  }
  return earlier.toSorted().at(-1) ?? null;
});

function dailyNotePath(
  path: Path.Path,
  vault: GeneralVaultPaths,
  device: MemoryDevice,
  day: string,
) {
  return path.join(vault.daily, day.slice(0, 4), `${dailyNoteName(day, device.label)}.md`);
}

function projectNotePath(
  path: Path.Path,
  vault: GeneralVaultPaths,
  device: MemoryDevice,
  noteName: string,
) {
  return path.join(vault.projects, noteName, `${projectNoteFileName(noteName, device.label)}.md`);
}

const formatInboxNote = (note: InboxNote) =>
  `## ${note.fileName}\n\n${note.content.trim().slice(0, INBOX_NOTE_LIMIT)}`;

/**
 * New inbox notes that fit in the prompt after the ones already processed for
 * the day. The rest stay in the inbox for the next summary.
 */
function fitInboxNotes(
  processed: ReadonlyArray<InboxNote>,
  candidates: ReadonlyArray<InboxNote>,
): ReadonlyArray<InboxNote> {
  let used = processed.reduce((total, note) => total + formatInboxNote(note).length + 2, 0);
  const fitted: InboxNote[] = [];
  for (const note of candidates) {
    const size = formatInboxNote(note).length + 2;
    if (used + size > INBOX_PROMPT_LIMIT) break;
    used += size;
    fitted.push(note);
  }
  return fitted;
}

/**
 * Project id to note name. Projects share a title-based note only when they
 * share a workspace; another project with the same title gets its own note.
 */
const resolveProjectNoteNames = Effect.fn("memory.resolveProjectNoteNames")(function* (
  vault: GeneralVaultPaths,
  device: MemoryDevice,
  threads: ReadonlyArray<MemoryThreadActivity>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = new Map<string, string>();
  // Lower-case note name to the workspace that owns it in this run.
  const owners = new Map<string, string>();
  for (const thread of threads) {
    if (names.has(thread.projectId)) continue;
    const base = projectNoteName(thread.projectTitle);
    // Suffixes go after the base name's length cap, so each attempt is a new name.
    const folder = path
      .basename(path.dirname(thread.workspaceRoot))
      .replace(/[\\/:*?"<>|#^[\]]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const qualified = folder.length > 0 ? `${base} (${folder})` : base;
    for (let attempt = 1; ; attempt++) {
      const candidate =
        attempt === 1
          ? base
          : attempt === 2 && qualified !== base
            ? qualified
            : `${qualified} ${attempt}`;
      const key = candidate.toLowerCase();
      let owner = owners.get(key);
      if (owner === undefined) {
        const existing = yield* fs
          .readFileString(projectNotePath(path, vault, device, candidate))
          .pipe(Effect.option);
        // A note without a workspace, such as one the user started, is shared.
        owner =
          (existing._tag === "Some" ? projectNoteWorkspace(existing.value) : null) ??
          thread.workspaceRoot;
      }
      if (owner === thread.workspaceRoot) {
        owners.set(key, owner);
        names.set(thread.projectId, candidate);
        break;
      }
    }
  }
  return names;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;
  const externalContent = yield* ExternalContent.ExternalContent;
  const environment = yield* ServerEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const vault = generalVaultPaths(path, config.memoryDir);
  const descriptor = yield* environment.getDescriptor;
  const status = yield* Ref.make<SummarizerStatus>({ state: "idle", message: null });
  const lock = yield* Semaphore.make(1);
  const removeAutomaticSkill = Effect.fn("DailyMemory.removeAutomaticSkill")(function* () {
    const settings = yield* settingsService.getSettings;
    const home = yield* resolveCodexHomeLayout(getManagedCodexSettings(settings));
    return yield* removeMemorySkill({
      skillsDirectory: path.join(home.sharedHomePath, "skills"),
      vaultPath: vault.root,
    });
  });
  // An ambient skill could feed synced integration text to an ordinary coding runtime.
  // Remove the old host-generated path before any new client turn can start.
  yield* removeAutomaticSkill();

  const provide = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SqlClient.SqlClient, sql),
    );

  const writeProjectNotes = Effect.fn("memory.writeProjectNotes")(function* (input: {
    readonly device: MemoryDevice;
    readonly devicePaths: DevicePaths;
    readonly day: string;
    readonly threads: ReadonlyArray<MemoryThreadActivity>;
    readonly projectNoteNames: ReadonlyMap<string, string>;
    readonly recentByNoteName: ReadonlyMap<string, string>;
  }) {
    const seen = new Set<string>();
    for (const thread of input.threads) {
      const noteName = input.projectNoteNames.get(thread.projectId);
      if (!noteName || seen.has(noteName)) continue;
      seen.add(noteName);
      const filePath = projectNotePath(path, vault, input.device, noteName);
      const existing = yield* fs.readFileString(filePath).pipe(Effect.option);
      const content =
        existing._tag === "Some"
          ? existing.value
          : renderProjectNote({
              title: thread.projectTitle,
              workspaceRoot: thread.workspaceRoot,
              deviceLabel: input.device.label,
            });
      const titles = input.threads
        .filter((candidate) => input.projectNoteNames.get(candidate.projectId) === noteName)
        .map((candidate) => candidate.title);
      const recent =
        input.recentByNoteName.get(noteName.toLowerCase()) ?? `Worked on ${titles.join("; ")}.`;
      yield* provide(
        writeGeneratedFile({
          vault,
          device: input.devicePaths,
          filePath,
          contents: appendProjectRecentLine(
            content,
            dailyNoteName(input.day, input.device.label),
            recent,
          ),
        }),
      );
    }
  });

  /** Inbox notes a summary of `day` would include, already moved or still waiting. */
  const dayInbox = Effect.fn("memory.dayInbox")(function* (
    device: DevicePaths,
    day: string,
    beforeMs: number,
  ) {
    const newInboxNotes = yield* provide(readInboxNotes(device.inbox, beforeMs));
    // A day summarized again keeps the inbox notes an earlier run already moved.
    const processedNotes = yield* provide(
      readInboxNotes(path.join(device.processed, day), Number.POSITIVE_INFINITY),
    );
    return { processedNotes, includedInboxNotes: fitInboxNotes(processedNotes, newInboxNotes) };
  });

  /**
   * Writes this device's note for `day` from its threads and inbox notes.
   * Returns the note's vault-relative path and hash, or null when the day had
   * nothing to summarize.
   */
  const summarizeDay = Effect.fn("memory.summarizeDay")(function* (input: {
    readonly day: string;
    readonly codexHome: string;
    readonly device: MemoryDevice;
    readonly devicePaths: DevicePaths;
    readonly noteStatus: "partial" | "final";
    readonly nowMs: number;
  }) {
    const { day, device } = input;
    const range = localDayRange(day);
    const threads = yield* provide(loadDayActivity(range));
    const { processedNotes, includedInboxNotes } = yield* dayInbox(
      input.devicePaths,
      day,
      Math.min(Date.parse(range.endIso), input.nowMs),
    );
    if (threads.length === 0 && processedNotes.length === 0 && includedInboxNotes.length === 0) {
      // An earlier note for the day, such as a partial one whose thread was
      // since deleted, no longer describes anything.
      yield* provide(
        removeGeneratedFile({
          vault,
          device: input.devicePaths,
          filePath: dailyNotePath(path, vault, device, day),
        }),
      );
      return null;
    }

    const settings = yield* settingsService.getSettings;
    const projectNoteNames = yield* provide(resolveProjectNoteNames(vault, device, threads));
    const generateDailyMemory = textGeneration.generateDailyMemory;
    if (!generateDailyMemory) {
      return yield* new TextGenerationError({
        operation: "generateDailyMemory",
        detail: "Text generation does not support daily memory.",
      });
    }
    const owner = `memory:${descriptor.environmentId}:${day}`;
    for (const thread of threads)
      yield* externalContent.inherit(`thread:${thread.threadId}`, owner);
    if (processedNotes.length > 0 || includedInboxNotes.length > 0)
      yield* externalContent.markUnverified(owner, {
        kind: "derived",
        artifactKind: "memory",
        artifactId: `${descriptor.environmentId}:${day}`,
        contentDigest: sha256Bytes(
          new TextEncoder().encode(
            [...processedNotes, ...includedInboxNotes].map(formatInboxNote).join("\n\n"),
          ),
        ),
      });
    const summary = yield* generateDailyMemory({
      cwd: vault.root,
      day,
      projectNames: [...new Set(projectNoteNames.values())],
      activity: formatMemoryActivity(threads, projectNoteNames),
      inboxNotes: [...processedNotes, ...includedInboxNotes].map(formatInboxNote).join("\n\n"),
      modelSelection: settings.textGenerationModelSelection,
    });

    const sessionPaths = yield* provide(
      findSessionFiles(
        input.codexHome,
        new Set(threads.flatMap((thread) => (thread.codexThreadId ? [thread.codexThreadId] : []))),
      ),
    );
    const inboxMoves = yield* provide(
      planInboxMoves(vault, input.devicePaths, day, includedInboxNotes),
    );
    const rendered = renderDailyNote({
      day,
      deviceLabel: device.label,
      status: input.noteStatus,
      updatedThrough: DateTime.formatIso(DateTime.makeUnsafe(input.nowMs)),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      summary,
      threads,
      projectNoteNames,
      sessionPaths,
      previousDay: yield* provide(previousDailyNote(vault, device, day)),
      inboxLinks: [
        ...processedNotes.map((note) => inboxLink(path, vault, note.filePath)),
        ...inboxMoves.map((move) => move.link),
      ],
    });

    const notePath = dailyNotePath(path, vault, device, day);
    const hash = yield* provide(
      writeGeneratedFile({
        vault,
        device: input.devicePaths,
        filePath: notePath,
        contents: rendered,
      }),
    );
    // Moved only after the note that links them is safely written.
    yield* provide(applyInboxMoves(inboxMoves));

    // The model is given the resolved note names, so match them exactly.
    const recentByNoteName = new Map(
      summary.projects.map((entry) => [entry.project.trim().toLowerCase(), entry.recent]),
    );
    yield* writeProjectNotes({
      device,
      devicePaths: input.devicePaths,
      day,
      threads,
      projectNoteNames,
      recentByNoteName,
    });
    return {
      path: path.relative(vault.root, notePath).split(path.sep).join("/"),
      sha256: hash,
    };
  });

  /**
   * Writes today's partial note when four hours have passed since the last one
   * (or since midnight) and the day's input changed.
   */
  const updateToday = Effect.fn("memory.updateToday")(function* (input: {
    readonly today: string;
    readonly nowMs: number;
    readonly streamingSince: string;
    readonly codexHome: string;
    readonly device: MemoryDevice;
    readonly devicePaths: DevicePaths;
  }) {
    const range = localDayRange(input.today);
    const previous = yield* provide(readPartialProgress(input.devicePaths));
    const lastWrittenMs =
      previous?.day === input.today ? Date.parse(previous.writtenAt) : Date.parse(range.startIso);
    if (input.nowMs - lastWrittenMs < PARTIAL_INTERVAL_MS) return;
    // Wait for a turn in progress rather than summarize it without its result.
    if (yield* provide(hasStreamingMessages(range, input.streamingSince))) return;

    const inbox = yield* dayInbox(input.devicePaths, input.today, input.nowMs);
    const fingerprint = [
      yield* provide(activityFingerprint(range)),
      ...[...inbox.processedNotes, ...inbox.includedInboxNotes]
        .map((note) => note.fileName.replace(/-\d+\.md$/u, ".md"))
        .toSorted(),
    ].join("|");
    if (previous?.day === input.today && previous.fingerprint === fingerprint) return;

    yield* Ref.set(status, { state: "summarizing", message: `Updating ${input.today}.` });
    const note = yield* summarizeDay({
      day: input.today,
      codexHome: input.codexHome,
      device: input.device,
      devicePaths: input.devicePaths,
      noteStatus: "partial",
      nowMs: input.nowMs,
    });
    if (note === null) return;
    yield* provide(
      writePartialProgress(input.devicePaths, {
        day: input.today,
        writtenAt: DateTime.formatIso(DateTime.makeUnsafe(input.nowMs)),
        fingerprint,
      }),
    );
  });

  const catchUp = provide(
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const codexHome = (yield* resolveCodexHomeLayout(getManagedCodexSettings(settings)).pipe(
        Effect.provideService(Path.Path, path),
      )).sharedHomePath;
      yield* removeAutomaticSkill();

      if (!settings.memoryEnabled) {
        yield* Ref.set(status, { state: "idle", message: null });
        return;
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const device = yield* provide(
        registerMemoryDevice({
          vault,
          environmentId: descriptor.environmentId,
          computerName: descriptor.label,
          platform: descriptor.platform.os,
          nowIso: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        }),
      );
      const ownPaths = devicePaths(path, vault, device);
      yield* provide(ensureGeneralVault(vault, device));

      const today = localDayAt(nowMs);
      const progress = yield* provide(readSummaryProgress(ownPaths));
      const days = pendingMemoryDays({
        lastSummarizedDay: progress?.lastSummarizedDay ?? null,
        today,
        maxCatchUpDays: MAX_CATCH_UP_DAYS,
      });
      // Days skipped by the catch-up cap were never examined, so coverage
      // restarts at the first pending day after a gap or on the first run.
      const continues =
        progress !== null && days[0] === addLocalDays(progress.lastSummarizedDay, 1);
      const coveredFrom = continues ? progress.coveredFrom : (days[0] ?? null);
      const notes = continues ? { ...progress.notes } : {};
      const streamingSince = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { hours: STREAMING_GRACE_HOURS }),
      );
      let finishedDaysDone = true;
      for (const day of days) {
        // Turning Memory off lets the day in progress finish, then stops the pass.
        if (!(yield* settingsService.getSettings).memoryEnabled) {
          finishedDaysDone = false;
          break;
        }
        // A turn from that day still streaming would be summarized without its
        // result, so the day waits for a later check.
        if (yield* provide(hasStreamingMessages(localDayRange(day), streamingSince))) {
          finishedDaysDone = false;
          break;
        }
        yield* Ref.set(status, { state: "summarizing", message: `Summarizing ${day}.` });
        const note = yield* summarizeDay({
          day,
          codexHome,
          device,
          devicePaths: ownPaths,
          noteStatus: "final",
          nowMs,
        });
        if (note !== null) notes[day] = note;
        yield* provide(
          writeSummaryProgress(ownPaths, { coveredFrom, lastSummarizedDay: day, notes }),
        );
      }
      // Finished days come first; today waits until they are all written.
      if (finishedDaysDone && (yield* settingsService.getSettings).memoryEnabled) {
        yield* updateToday({
          today,
          nowMs,
          streamingSince,
          codexHome,
          device,
          devicePaths: ownPaths,
        });
      }
      yield* Ref.set(status, { state: "idle", message: null });
    }),
  ).pipe(
    Effect.catchCause((cause) => {
      const failure = Cause.squash(cause);
      const message = failure instanceof Error ? failure.message : String(failure);
      return Ref.set(status, {
        state: "error",
        message: message.trim() || "Memory update failed.",
      }).pipe(
        Effect.andThen(
          Effect.logWarning("daily memory update failed", { cause: Cause.pretty(cause) }),
        ),
      );
    }),
  );

  const runCatchUp = lock.withPermits(1)(catchUp);

  const getStatus = Effect.gen(function* () {
    const enabled = yield* settingsService.getSettings.pipe(
      Effect.map((settings) => settings.memoryEnabled),
      Effect.orElseSucceed(() => false),
    );
    const current = yield* Ref.get(status);
    const device = yield* provide(findMemoryDevice(vault, descriptor.environmentId));
    const progress = device
      ? yield* provide(readSummaryProgress(devicePaths(path, vault, device)))
      : null;
    return {
      enabled,
      directoryPath: config.memoryDir,
      generalDirectoryPath: vault.root,
      state: enabled ? current.state : "disabled",
      lastSummarizedDay: progress?.lastSummarizedDay ?? null,
      message: enabled ? current.message : null,
    } satisfies Omit<ServerMemoryStatus, "sync">;
  });

  const getProjectMemory = Effect.fn("DailyMemory.getProjectMemory")(function* (
    input: ServerProjectMemoryInput,
  ) {
    const projects = yield* sql<{ title: string; workspaceRoot: string }>`
      SELECT title, workspace_root AS "workspaceRoot" FROM projection_projects
      WHERE project_id = ${input.projectId} AND deleted_at IS NULL
    `.pipe(
      Effect.mapError(
        () => new ServerProjectMemoryError({ message: "Could not read this project." }),
      ),
    );
    const project = projects[0];
    if (!project)
      return yield* new ServerProjectMemoryError({
        message: "This project is no longer available.",
      });
    const reports = yield* sql<{ threadId: string; text: string; updatedAt: string }>`
      WITH recent_threads AS (
        SELECT thread_id FROM harness_activity_threads
        WHERE project_id = ${input.projectId} AND deleted_at IS NULL AND archived_at IS NULL
        ORDER BY updated_at DESC LIMIT 16
      )
      SELECT m.thread_id AS "threadId", substr(m.text, 1, 600) AS text,
        m.updated_at AS "updatedAt"
      FROM recent_threads t JOIN harness_activity_messages m ON m.message_id = (
        SELECT last.message_id FROM harness_activity_messages last
        WHERE last.thread_id = t.thread_id AND last.role = 'assistant'
          AND last.is_streaming = 0 AND trim(last.text) <> ''
        ORDER BY last.created_at DESC, last.message_id DESC LIMIT 1
      )
    `.pipe(
      Effect.mapError(
        () => new ServerProjectMemoryError({ message: "Could not read recent project updates." }),
      ),
    );
    const recentUpdates = reports.map((report) => ({
      ...report,
      threadId: ThreadId.make(report.threadId),
    }));
    const empty = (state: "disabled" | "pending"): ServerProjectMemory => ({
      state,
      markdown: null,
      relativePath: null,
      updatedAt: null,
      recentUpdates,
    });
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () => new ServerProjectMemoryError({ message: "Could not read memory settings." }),
      ),
    );
    if (!settings.memoryEnabled) return empty("disabled");
    const root = yield* fs.realPath(vault.projects).pipe(Effect.option);
    if (root._tag === "None") return empty("pending");
    const folders = yield* fs
      .readDirectory(root.value)
      .pipe(
        Effect.mapError(
          () => new ServerProjectMemoryError({ message: "Could not read project memory." }),
        ),
      );
    const base = projectNoteName(project.title);
    // Synced device notes are useful too. Match the workspace in the note,
    // never its title alone, and retain the source's device in relativePath.
    const candidates = [base, ...folders.filter((name) => name !== base).toSorted()].slice(0, 256);
    let newest: { markdown: string; relativePath: string; updatedAt: string | null } | null = null;
    for (const name of candidates) {
      const files = yield* fs
        .readDirectory(path.join(root.value, name))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const file of files
        .filter((file) => file.startsWith(`${name} - `) && file.endsWith(".md"))
        .slice(0, 16)) {
        const candidate = path.join(root.value, name, file);
        const resolved = yield* fs.realPath(candidate).pipe(Effect.option);
        if (resolved._tag === "None") continue;
        const relative = path.relative(root.value, resolved.value);
        if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
          continue;
        const info = yield* fs.stat(resolved.value).pipe(Effect.option);
        if (info._tag === "None" || info.value.type !== "File" || info.value.size > 131_072n)
          continue;
        const content = yield* fs.readFileString(resolved.value).pipe(Effect.option);
        if (
          content._tag === "None" ||
          projectNoteWorkspace(content.value) !== project.workspaceRoot
        )
          continue;
        const match = {
          markdown: content.value,
          relativePath: path.relative(vault.root, resolved.value),
          updatedAt: info.value.mtime._tag === "Some" ? info.value.mtime.value.toISOString() : null,
        };
        if (newest === null || (match.updatedAt ?? "") > (newest.updatedAt ?? "")) newest = match;
      }
    }
    if (newest) return { state: "ready", ...newest, recentUpdates } satisfies ServerProjectMemory;
    return empty("pending");
  });

  return DailyMemory.of({
    runCatchUp,
    getStatus,
    getProjectMemory,
    exclusive: lock.withPermits(1),
  });
});

/** Runs catch-up after startup, every hour, and whenever Memory is switched. */
export const layer = Layer.effect(
  DailyMemory,
  Effect.gen(function* () {
    const service = yield* make;
    const settings = yield* ServerSettingsService;
    yield* Effect.sleep(STARTUP_DELAY).pipe(
      Effect.andThen(service.runCatchUp.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)))),
      Effect.forkScoped,
    );
    yield* settings.streamChanges.pipe(
      Stream.map((next) => next.memoryEnabled),
      Stream.changes,
      Stream.runForEach(() => service.runCatchUp),
      Effect.forkScoped,
    );
    return service;
  }),
);
