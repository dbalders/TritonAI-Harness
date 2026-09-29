/**
 * DailyMemory - writes one note per finished day into the general memory
 * vault, and keeps the Codex memory skill in step with the Memory setting.
 *
 * The summarizer remembers the last day it finished. On startup, every hour,
 * and when Memory is turned on, it summarizes each finished day after that
 * one, oldest first, and records each day only after its note is written. A
 * run that stops halfway resumes at the first unfinished day. Days without
 * thread activity are recorded without calling the model.
 */
import { type ServerMemoryStatus, TextGenerationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { localDayAt, localDayRange, pendingMemoryDays } from "./memoryDays.ts";
import {
  appendProjectRecentLine,
  formatMemoryActivity,
  type MemoryActivityMessage,
  type MemoryThreadActivity,
  mergeDailyNote,
  projectNoteName,
  projectNoteWorkspace,
  renderDailyNote,
  renderProjectNote,
  selectMemoryMessages,
} from "./memoryNotes.ts";
import {
  ensureGeneralVault,
  generalVaultPaths,
  type GeneralVaultPaths,
  installMemorySkill,
  readLastSummarizedDay,
  removeMemorySkill,
  renderMemorySkill,
  writeLastSummarizedDay,
} from "./memoryVault.ts";

const MAX_CATCH_UP_DAYS = 7;
const CHECK_INTERVAL = Duration.hours(1);
// Let startup work finish before the first check competes with it.
const STARTUP_DELAY = Duration.seconds(30);
const INBOX_NOTE_LIMIT = 8_000;
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
    readonly getStatus: Effect.Effect<ServerMemoryStatus>;
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
      CASE
        WHEN json_valid(r.resume_cursor_json) THEN json_extract(r.resume_cursor_json, '$.threadId')
      END AS "codexThreadId"
    FROM projection_thread_messages AS m
    JOIN projection_threads AS t ON t.thread_id = m.thread_id
    JOIN projection_projects AS p ON p.project_id = t.project_id
    LEFT JOIN provider_session_runtime AS r
      ON r.thread_id = t.thread_id AND r.provider_name = 'codex'
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

/** Chooses where each processed note goes under `Inbox/processed/<day>/`. */
const planInboxMoves = Effect.fn("memory.planInboxMoves")(function* (
  paths: GeneralVaultPaths,
  day: string,
  notes: ReadonlyArray<InboxNote>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetDirectory = path.join(paths.processed, day);
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
      link: `Inbox/processed/${day}/${targetName.replace(/\.md$/u, "")}`,
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

const previousDailyNote = Effect.fn("memory.previousDailyNote")(function* (
  paths: GeneralVaultPaths,
  day: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const names = yield* fs
    .readDirectory(paths.daily)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const earlier = names
    .map((name) => /^(\d{4}-\d{2}-\d{2})\.md$/u.exec(name)?.[1])
    .filter((name): name is string => name !== undefined && name < day)
    .toSorted();
  return earlier.at(-1) ?? null;
});

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
  paths: GeneralVaultPaths,
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
          .readFileString(path.join(paths.projects, `${candidate}.md`))
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const paths = generalVaultPaths(path, config.memoryDir);
  const status = yield* Ref.make<SummarizerStatus>({ state: "idle", message: null });
  const lock = yield* Semaphore.make(1);

  const provide = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SqlClient.SqlClient, sql),
    );

  const writeProjectNotes = Effect.fn("memory.writeProjectNotes")(function* (input: {
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
      const filePath = path.join(paths.projects, `${noteName}.md`);
      const existing = yield* fs.readFileString(filePath).pipe(Effect.option);
      const content =
        existing._tag === "Some"
          ? existing.value
          : renderProjectNote({ title: thread.projectTitle, workspaceRoot: thread.workspaceRoot });
      const titles = input.threads
        .filter((candidate) => input.projectNoteNames.get(candidate.projectId) === noteName)
        .map((candidate) => candidate.title);
      const recent =
        input.recentByNoteName.get(noteName.toLowerCase()) ?? `Worked on ${titles.join("; ")}.`;
      yield* writeFileStringAtomically({
        filePath,
        contents: appendProjectRecentLine(content, input.day, recent),
      });
    }
  });

  const summarizeDay = Effect.fn("memory.summarizeDay")(function* (day: string, codexHome: string) {
    const range = localDayRange(day);
    const threads = yield* provide(loadDayActivity(range));
    if (threads.length === 0) return;

    const settings = yield* settingsService.getSettings;
    const newInboxNotes = yield* provide(readInboxNotes(paths.inbox, Date.parse(range.endIso)));
    // A day summarized again keeps the inbox notes an earlier run already moved.
    const processedNotes = yield* provide(
      readInboxNotes(path.join(paths.processed, day), Number.POSITIVE_INFINITY),
    );
    const includedInboxNotes = fitInboxNotes(processedNotes, newInboxNotes);
    const projectNoteNames = yield* provide(resolveProjectNoteNames(paths, threads));
    const generateDailyMemory = textGeneration.generateDailyMemory;
    if (!generateDailyMemory) {
      return yield* new TextGenerationError({
        operation: "generateDailyMemory",
        detail: "Text generation does not support daily memory.",
      });
    }
    const summary = yield* generateDailyMemory({
      cwd: paths.root,
      day,
      projectNames: [...new Set(projectNoteNames.values())],
      activity: formatMemoryActivity(threads, projectNoteNames),
      inboxNotes: [...processedNotes, ...includedInboxNotes].map(formatInboxNote).join("\n\n"),
      modelSelection: settings.textGenerationModelSelection,
    });

    const sessionPaths = yield* provide(
      findSessionFiles(
        codexHome,
        new Set(threads.flatMap((thread) => (thread.codexThreadId ? [thread.codexThreadId] : []))),
      ),
    );
    const inboxMoves = yield* provide(planInboxMoves(paths, day, includedInboxNotes));
    const rendered = renderDailyNote({
      day,
      summary,
      threads,
      projectNoteNames,
      sessionPaths,
      previousDay: yield* provide(previousDailyNote(paths, day)),
      inboxLinks: [
        ...processedNotes.map(
          (note) => `Inbox/processed/${day}/${note.fileName.replace(/\.md$/iu, "")}`,
        ),
        ...inboxMoves.map((move) => move.link),
      ],
    });

    const notePath = path.join(paths.daily, `${day}.md`);
    const existing = yield* fs.readFileString(notePath).pipe(Effect.option);
    yield* writeFileStringAtomically({
      filePath: notePath,
      contents: mergeDailyNote(Option.getOrNull(existing), rendered),
    });
    // Moved only after the note that links them is safely written.
    yield* provide(applyInboxMoves(inboxMoves));

    const recentByNoteName = new Map(
      summary.projects.map((entry) => [projectNoteName(entry.project).toLowerCase(), entry.recent]),
    );
    yield* writeProjectNotes({ day, threads, projectNoteNames, recentByNoteName });
  });

  const catchUp = provide(
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const codexHome = (yield* resolveCodexHomeLayout(settings.providers.codex).pipe(
        Effect.provideService(Path.Path, path),
      )).sharedHomePath;
      const skillsDirectory = path.join(codexHome, "skills");

      if (!settings.memoryEnabled) {
        yield* provide(removeMemorySkill(skillsDirectory));
        yield* Ref.set(status, { state: "idle", message: null });
        return;
      }

      yield* provide(ensureGeneralVault(paths));
      yield* provide(
        installMemorySkill({
          skillsDirectory,
          contents: renderMemorySkill({
            vaultPath: paths.root,
            sessionsPath: path.join(codexHome, "sessions"),
          }),
        }),
      );

      const today = localDayAt(yield* Clock.currentTimeMillis);
      const days = pendingMemoryDays({
        lastSummarizedDay: yield* provide(readLastSummarizedDay(paths)),
        today,
        maxCatchUpDays: MAX_CATCH_UP_DAYS,
      });
      for (const day of days) {
        // Turning Memory off lets the day in progress finish, then stops the pass.
        if (!(yield* settingsService.getSettings).memoryEnabled) break;
        yield* Ref.set(status, { state: "summarizing", message: `Summarizing ${day}.` });
        yield* summarizeDay(day, codexHome);
        yield* provide(writeLastSummarizedDay(paths, day));
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
    return {
      enabled,
      directoryPath: config.memoryDir,
      generalDirectoryPath: paths.root,
      state: enabled ? current.state : "disabled",
      lastSummarizedDay: yield* provide(readLastSummarizedDay(paths)),
      message: enabled ? current.message : null,
    } satisfies ServerMemoryStatus;
  });

  return DailyMemory.of({ runCatchUp, getStatus });
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
