// @effect-diagnostics nodeBuiltinImport:off - Deterministic synchronous idea identity uses a content digest.
// @effect-diagnostics globalDate:off - limits and labels use the host-local day.
/**
 * Ideas - suggestion cards on the Ideas page: things TritonAI could do next
 * for the user, from their own threads, memory notes, and project files, and
 * from plugins, catalog skills, and a starter library.
 *
 * Ideas are generated in batches by the text generation model, checked against
 * the context it was shown, and stored with a key naming what each is about.
 * Feedback on a key decides whether it comes back: dismissed ideas return
 * after two weeks, rejected and used ones never do. When the model cannot help
 * (no context, failure, or the daily limit), ready-made starter ideas fill the
 * batch, so asking for more always adds something while any are left.
 *
 * Every idea is ready to send as written: one that leaves a blank for the user
 * is never shown. No more than two visible ideas share a project or tool, and
 * generated ideas go stale after a few days, since the work they describe moves on.
 *
 * Accepting an idea opens a draft on the client. The idea stays listed until a
 * message from it is sent, which is detected here from the thread messages.
 */
import * as NodeCrypto from "node:crypto";
import {
  type Idea,
  IdeaAction,
  type IdeaFeedbackKind,
  type IdeaSection,
  ideaPromptSnippet,
  IdeaSource,
  IdeasError,
  type IdeasFeedbackInput,
  type IdeasGenerationState,
  type IdeasSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { listEnabledIntegrations } from "../integrations/IntegrationRegistry.ts";
import { localDayAt } from "../memory/memoryDays.ts";
import { findMemoryDevice, generalVaultPaths } from "../memory/memoryVault.ts";
import * as PublicSkillRepository from "../provider/publicSkillRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AnalyticsService } from "../telemetry/AnalyticsService.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import {
  type CandidateIdea,
  type ContextFile,
  type ContextNote,
  type ContextPlugin,
  type ContextProject,
  type ContextSkill,
  type ContextThread,
  formatIdeasContext,
  type IdeasContext,
  starterCandidate,
  validateGeneratedIdeas,
} from "./ideaContext.ts";
import {
  capBySubject,
  needsUserInput,
  IDEA_SECTIONS,
  ideaSubject,
  type SectionFeedback,
  sectionWeights,
  selectByMix,
} from "./ideaRules.ts";
import { availableStarters, IDEA_KINDS, STARTER_IDEAS } from "./starterIdeas.ts";

const DAY_MS = 24 * 60 * 60_000;
/** How many ideas the page aims to hold, and the most it keeps. */
const TARGET_IDEAS = 6;
const MAX_IDEAS = 12;
const SUGGEST_MORE_COUNT = 4;
/** Dismissed and expired ideas can come back after this. */
const DISMISS_COOLDOWN_MS = 14 * DAY_MS;
/** Generated ideas go stale; an opened draft that was never sent counts as dropped. */
const GENERATED_TTL_MS = 3 * DAY_MS;
const OPENED_TTL_MS = 3 * DAY_MS;
const FEEDBACK_WINDOW_MS = 90 * DAY_MS;
const AVOID_WINDOW_MS = 60 * DAY_MS;
const NEW_WINDOW_MS = 14 * DAY_MS;
const THREAD_WINDOW_MS = 14 * DAY_MS;
const FILE_WINDOW_MS = 60 * DAY_MS;
/**
 * Background generation only runs for someone who has opened the page lately.
 * Opening the page after longer away checks for new ideas then.
 */
const VIEW_WINDOW_MS = 2 * DAY_MS;
/** A page view this long after the previous one counts as a new visit in analytics. */
const VISIT_GAP_MS = 30 * 60_000;
const REFRESH_AFTER_MS = 4 * 60 * 60_000;
const DAILY_REFRESH_MS = DAY_MS;
const DAILY_MODEL_CALLS = 20;
const CHECK_INTERVAL = Duration.hours(1);
// Let startup work finish before the first check competes with it.
const STARTUP_DELAY = Duration.seconds(60);
const NOTE_COUNT = 5;
const PROJECT_COUNT = 8;
const FILES_PER_PROJECT = 8;
const DIRECTORY_ENTRY_LIMIT = 300;
const PROJECT_SCAN_LIMIT = 1_500;
const DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".xlsx",
  ".xls",
  ".docx",
  ".doc",
  ".pdf",
  ".pptx",
  ".md",
  ".txt",
  ".html",
  ".ipynb",
]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "venv",
  "__pycache__",
  "coverage",
]);

type IdeaStatus = "active" | "opened" | "snoozed" | "dismissed" | "rejected" | "sent" | "expired";

const IdeaContent = Schema.Struct({
  icon: Schema.String,
  title: Schema.String,
  body: Schema.String,
  sources: Schema.Array(IdeaSource),
  action: IdeaAction,
});
type IdeaContent = typeof IdeaContent.Type;
const decodeContent = Schema.decodeUnknownOption(Schema.fromJsonString(IdeaContent));
const encodeContent = Schema.encodeSync(Schema.fromJsonString(IdeaContent));
const isIdeasError = Schema.is(IdeasError);

interface IdeaRow {
  readonly ideaId: string;
  readonly ideaKey: string;
  readonly section: string;
  readonly contentJson: string;
  readonly status: IdeaStatus;
  readonly previousStatus: IdeaStatus | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly openedAt: string | null;
  readonly draftThreadIdsJson: string | null;
  readonly openedMessageIdsJson: string | null;
  readonly snoozedUntil: string | null;
  readonly hiddenAt: string | null;
}

interface GenerationStatus {
  readonly state: IdeasGenerationState;
  readonly message: string | null;
}

export class Ideas extends Context.Service<
  Ideas,
  {
    readonly list: Effect.Effect<IdeasSnapshot, IdeasError>;
    /** Records that the user opened the Ideas page, which clears the unseen count. */
    readonly markViewed: Effect.Effect<IdeasSnapshot, IdeasError>;
    /** Starts generating more ideas and returns at once; the snapshot says `generating`. */
    readonly suggestMore: Effect.Effect<IdeasSnapshot, IdeasError>;
    readonly feedback: (input: IdeasFeedbackInput) => Effect.Effect<IdeasSnapshot, IdeasError>;
    /** The background check: generates when the page is in use and its ideas are stale. */
    readonly refresh: Effect.Effect<void>;
    /** Waits for a generation in progress to finish. */
    readonly awaitIdle: Effect.Effect<void>;
  }
>()("t3/ideas/Ideas") {}

const toIso = (ms: number) => new Date(ms).toISOString();

function isSection(value: string): value is IdeaSection {
  return IDEA_SECTIONS.some((section) => section === value);
}

const STARTER_TITLES = new Map<string, string>(
  STARTER_IDEAS.map((starter) => [`starter:${starter.id}`, starter.title] as const),
);
const STARTER_KEYS = new Set(STARTER_TITLES.keys());
/** Raise when the starter library is replaced, so pages that showed the old one are topped up once. */
const STARTER_LIBRARY_VERSION = "2";

/** Ideas that must not stay on the page: a blank to fill in, or a starter no longer offered. */
function isOutdated(row: IdeaRow, content: IdeaContent): boolean {
  if (row.ideaKey.startsWith("starter:") && !STARTER_KEYS.has(row.ideaKey)) return true;
  return [content.title, content.body, content.action.prompt].some(needsUserInput);
}

interface PluginState {
  readonly id: string;
  readonly requiresConnection: boolean;
  readonly connectionState?: string | undefined;
}

function connectedPluginIds(plugins: ReadonlyArray<PluginState>): ReadonlySet<string> {
  return new Set(
    plugins
      .filter((plugin) => !plugin.requiresConnection || plugin.connectionState === "connected")
      .map((plugin) => plugin.id),
  );
}

const ThreadIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeThreadIds = Schema.decodeUnknownOption(ThreadIdsJson);
const encodeThreadIds = Schema.encodeSync(ThreadIdsJson);

/** The draft threads recorded for an idea, oldest first. */
function draftThreadIds(row: IdeaRow): ReadonlyArray<string> {
  if (row.draftThreadIdsJson === null) return [];
  return Option.getOrElse(decodeThreadIds(row.draftThreadIdsJson), () => []);
}

function toIdea(row: IdeaRow): Idea | null {
  const content = decodeContent(row.contentJson);
  if (Option.isNone(content) || !isSection(row.section)) return null;
  return {
    id: row.ideaId,
    section: row.section,
    icon: content.value.icon,
    // A saved starter card shows the library's current wording.
    title: STARTER_TITLES.get(row.ideaKey) ?? content.value.title,
    body: content.value.body,
    sources: content.value.sources,
    action: content.value.action,
    createdAt: row.createdAt,
    openedAt: row.openedAt,
    draftThreadIds: draftThreadIds(row).map((threadId) => ThreadId.make(threadId)),
    snoozedUntil: row.status === "snoozed" ? row.snoozedUntil : null,
  };
}

const ideaColumns = (sql: SqlClient.SqlClient) => sql`
  idea_id AS "ideaId",
  idea_key AS "ideaKey",
  section,
  content_json AS "contentJson",
  status,
  previous_status AS "previousStatus",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  opened_at AS "openedAt",
  draft_thread_ids_json AS "draftThreadIdsJson",
  opened_message_ids_json AS "openedMessageIdsJson",
  snoozed_until AS "snoozedUntil",
  hidden_at AS "hiddenAt"
`;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;
  const environment = yield* ServerEnvironment;
  const skills = yield* Effect.serviceOption(PublicSkillRepository.PublicSkillRepository);
  const analytics = yield* Effect.serviceOption(AnalyticsService);
  /** Anonymous usage counts only: sections, kinds, and numbers, never what an idea says. */
  const track = (event: string, properties: Readonly<Record<string, string | number | boolean>>) =>
    Option.isSome(analytics) ? analytics.value.record(event, properties) : Effect.void;
  const status = yield* Ref.make<GenerationStatus>({ state: "idle", message: null });
  const setGenerationStatus = (next: GenerationStatus) => Ref.set(status, next);
  const lock = yield* Semaphore.make(1);
  const seedLock = yield* Semaphore.make(1);
  const feedbackLock = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;
  // The generation started from the page, so callers can wait for it.
  const running = yield* Ref.make<Fiber.Fiber<void> | null>(null);

  const readState = (key: string) =>
    sql<{ readonly value: string }>`SELECT value FROM idea_state WHERE key = ${key}`.pipe(
      Effect.map((rows) => rows[0]?.value ?? null),
    );
  const writeState = (key: string, value: string) =>
    sql`
      INSERT INTO idea_state (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `;

  /**
   * Moves an idea from the state `row` was read in. Applies only if nothing else
   * changed it since, so a background retirement is never silently undone, and
   * says whether it applied.
   */
  const setStatus = (row: IdeaRow, status: string, nowIso: string, fields: Partial<IdeaRow>) =>
    sql`
      UPDATE ideas SET
        status = ${status},
        previous_status = ${fields.previousStatus ?? null},
        opened_at = COALESCE(${fields.openedAt ?? null}, opened_at),
        snoozed_until = ${fields.snoozedUntil ?? null},
        hidden_at = ${fields.hiddenAt ?? null},
        updated_at = ${nowIso}
      WHERE idea_id = ${row.ideaId} AND status = ${row.status} AND updated_at = ${row.updatedAt}
      RETURNING idea_id AS "ideaId"
    `.pipe(Effect.map((updated) => updated.length > 0));

  const recordFeedback = (row: IdeaRow, kind: IdeaFeedbackKind, nowIso: string) =>
    sql`
      INSERT INTO idea_feedback (idea_id, section, kind, created_at)
      VALUES (${row.ideaId}, ${row.section}, ${kind}, ${nowIso})
    `.pipe(Effect.andThen(track("ideas.feedback", { kind, section: row.section })));

  /** Retires an idea the user has not acted on since it was read, leaving any newer press alone. */
  const retire = (row: IdeaRow, next: "sent" | "dismissed" | "expired", nowIso: string) =>
    sql`
      UPDATE ideas SET status = ${next}, previous_status = NULL, hidden_at = ${nowIso}, updated_at = ${nowIso}
      WHERE idea_id = ${row.ideaId} AND status = ${row.status} AND updated_at = ${row.updatedAt}
      RETURNING idea_id AS "ideaId"
    `.pipe(
      Effect.tap((updated) =>
        next === "sent" && updated.length > 0
          ? track("ideas.sent", { section: row.section })
          : Effect.void,
      ),
    );

  /**
   * Whether a message was sent from an opened idea's draft, without trusting
   * message times, which can come from a client with a skewed clock:
   * - a draft thread recorded for the idea counts once it has any user message;
   * - an existing thread counts once it has a user message it didn't have when opened.
   * Without either, a message after the open containing the prompt's fixed text counts.
   */
  const wasSent = (row: IdeaRow, content: IdeaContent, openedAt: string) => {
    if (content.action.kind === "resume-thread") {
      if (row.openedMessageIdsJson !== null) {
        return sql<{ readonly found: number }>`
          SELECT EXISTS (
            SELECT 1 FROM harness_activity_messages
            WHERE thread_id = ${content.action.threadId}
              AND role = 'user'
              AND message_id NOT IN (SELECT value FROM json_each(${row.openedMessageIdsJson}))
          ) AS "found"
        `.pipe(Effect.map(([found]) => Boolean(found?.found)));
      }
      return sql<{ readonly found: number }>`
        SELECT EXISTS (
          SELECT 1 FROM harness_activity_messages
          WHERE thread_id = ${content.action.threadId} AND role = 'user' AND created_at > ${openedAt}
        ) AS "found"
      `.pipe(Effect.map(([found]) => Boolean(found?.found)));
    }
    const threadIds = draftThreadIds(row);
    if (threadIds.length > 0) {
      return sql<{ readonly found: number }>`
        SELECT EXISTS (
          SELECT 1 FROM harness_activity_messages
          WHERE thread_id IN (SELECT value FROM json_each(${encodeThreadIds(threadIds)}))
            AND role = 'user'
        ) AS "found"
      `.pipe(Effect.map(([found]) => Boolean(found?.found)));
    }
    const snippet = ideaPromptSnippet(content.action.prompt);
    // Too little fixed text would match unrelated messages.
    if (snippet.length < 12) return Effect.succeed(false);
    return sql<{ readonly found: number }>`
      SELECT EXISTS (
        SELECT 1 FROM harness_activity_messages
        WHERE role = 'user' AND created_at > ${openedAt} AND instr(text, ${snippet}) > 0
      ) AS "found"
    `.pipe(Effect.map(([found]) => Boolean(found?.found)));
  };

  const threadIsGone = (threadId: string) =>
    sql<{ readonly gone: number }>`
      SELECT NOT EXISTS (
        SELECT 1 FROM harness_activity_threads
        WHERE thread_id = ${threadId} AND deleted_at IS NULL AND archived_at IS NULL
      ) AS "gone"
    `.pipe(Effect.map(([row]) => Boolean(row?.gone)));

  /**
   * Wakes snoozed ideas, marks opened ideas sent or dropped, and retires stale
   * generated ideas, outdated ones, and ideas whose thread is gone.
   */
  const tidy = Effect.fn("ideas.tidy")(function* (nowMs: number) {
    const nowIso = toIso(nowMs);
    yield* sql`
      UPDATE ideas SET
        status = COALESCE(previous_status, 'active'),
        previous_status = NULL,
        snoozed_until = NULL,
        updated_at = ${nowIso}
      WHERE status = 'snoozed' AND snoozed_until <= ${nowIso}
    `;
    const rows = yield* sql<IdeaRow>`
      SELECT ${ideaColumns(sql)} FROM ideas WHERE status IN ('active', 'opened')
    `;
    for (const row of rows) {
      const content = decodeContent(row.contentJson);
      if (Option.isNone(content)) continue;
      // Sent counts from the original open, so a message sent while snoozed is still seen.
      if (row.openedAt !== null && (yield* wasSent(row, content.value, row.openedAt))) {
        yield* retire(row, "sent", nowIso);
        continue;
      }
      const goneThread =
        content.value.action.kind === "resume-thread" &&
        (yield* threadIsGone(content.value.action.threadId));
      if (goneThread) {
        yield* retire(row, "expired", nowIso);
        continue;
      }
      // Both clocks restart when the card is woken from a snooze or restored.
      const since = Date.parse(row.updatedAt);
      if (row.status === "opened" && row.openedAt !== null) {
        if (nowMs - Math.max(Date.parse(row.openedAt), since) > OPENED_TTL_MS) {
          yield* retire(row, "dismissed", nowIso);
        }
        continue;
      }
      // Any generated idea draws on the user's work or tools as they were, whatever its section.
      const stale = row.section !== "starter" && nowMs - since > GENERATED_TTL_MS;
      if (stale || isOutdated(row, content.value)) {
        yield* retire(row, "expired", nowIso);
      }
    }
  });

  const insertIdeas = Effect.fn("ideas.insertIdeas")(function* (
    ideas: ReadonlyArray<CandidateIdea>,
    nowIso: string,
  ) {
    for (const idea of ideas) {
      const content = encodeContent({
        icon: idea.icon,
        title: idea.title,
        body: idea.body,
        sources: idea.sources,
        action: idea.action,
      });
      yield* sql`
        INSERT INTO ideas (idea_id, idea_key, section, content_json, status, created_at, updated_at)
        VALUES (${NodeCrypto.randomUUID()}, ${idea.key}, ${idea.section}, ${content}, 'active', ${nowIso}, ${nowIso})
      `;
    }
  });

  /** Gives a first visit something to look at before anything has been generated. */
  /**
   * Gives a first visit something to look at before anything has been generated,
   * and once tops up a page whose old starter ideas were just retired.
   */
  const seedStarters = (nowMs: number) =>
    // Two first requests at once must not both seed.
    seedLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* readState("starter_library")) === STARTER_LIBRARY_VERSION) return;
        const [row] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count" FROM ideas WHERE status IN ('active', 'opened', 'snoozed')
        `;
        const slots = TARGET_IDEAS - (row?.count ?? 0);
        if (slots > 0) {
          const connected = connectedPluginIds(yield* loadPlugins);
          const starters = availableStarters(connected).map(starterCandidate);
          yield* insertIdeas(
            capBySubject(starters, yield* loadVisibleSubjects).slice(0, slots),
            toIso(nowMs),
          );
        }
        yield* writeState("starter_library", STARTER_LIBRARY_VERSION);
      }),
    );

  const snapshot = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* tidy(nowMs);
    yield* seedStarters(nowMs);
    const rows = yield* sql<IdeaRow>`
      SELECT ${ideaColumns(sql)} FROM ideas
      WHERE status IN ('active', 'opened', 'snoozed')
      ORDER BY created_at ASC, rowid ASC
    `;
    const lastViewedAt = yield* readState("last_viewed_at");
    const ideas: Idea[] = [];
    const snoozed: Idea[] = [];
    let unseenCount = 0;
    for (const row of rows) {
      const idea = toIdea(row);
      if (!idea) continue;
      if (row.status === "snoozed") {
        snoozed.push(idea);
        continue;
      }
      ideas.push(idea);
      if (row.status === "active" && (lastViewedAt === null || row.createdAt > lastViewedAt)) {
        unseenCount++;
      }
    }
    const sectionOrder = (idea: Idea) => IDEA_SECTIONS.indexOf(idea.section);
    const current = yield* Ref.get(status);
    return {
      ideas: ideas.toSorted((left, right) => sectionOrder(left) - sectionOrder(right)),
      snoozed: snoozed.toSorted((left, right) =>
        (left.snoozedUntil ?? "").localeCompare(right.snoozedUntil ?? ""),
      ),
      unseenCount,
      state: current.state,
      message: current.message,
      generatedAt: yield* readState("last_generated_at"),
    } satisfies IdeasSnapshot;
  });

  // Context

  const loadProjects = sql<ContextProject & { readonly workspaceRoot: string }>`
    SELECT
      p.project_id AS "id",
      p.title AS "title",
      p.workspace_root AS "workspaceRoot"
    FROM projection_projects AS p
    WHERE p.deleted_at IS NULL
    ORDER BY COALESCE(
      (SELECT MAX(t.updated_at) FROM harness_activity_threads AS t
        WHERE t.project_id = p.project_id AND t.deleted_at IS NULL),
      p.updated_at
    ) DESC
    LIMIT ${PROJECT_COUNT}
  `;

  const loadThreads = Effect.fn("ideas.loadThreads")(function* (nowMs: number) {
    const rows = yield* sql<{
      readonly id: string;
      readonly title: string;
      readonly projectId: string;
      readonly updatedAt: string;
      readonly settledAt: string | null;
      readonly snoozedUntil: string | null;
      readonly waiting: number;
      readonly lastUserMessage: string | null;
      readonly lastReply: string | null;
    }>`
      SELECT
        t.thread_id AS "id",
        t.title AS "title",
        t.project_id AS "projectId",
        t.updated_at AS "updatedAt",
        t.settled_at AS "settledAt",
        t.snoozed_until AS "snoozedUntil",
        t.pending_user_input_count + t.pending_approval_count AS "waiting",
        (SELECT m.text FROM harness_activity_messages AS m
          WHERE m.thread_id = t.thread_id AND m.role = 'user' AND m.is_streaming = 0
          ORDER BY m.created_at DESC LIMIT 1) AS "lastUserMessage",
        (SELECT m.text FROM harness_activity_messages AS m
          WHERE m.thread_id = t.thread_id AND m.role = 'assistant' AND m.is_streaming = 0
          ORDER BY m.created_at DESC LIMIT 1) AS "lastReply"
      FROM harness_activity_threads AS t
      JOIN projection_projects AS p ON p.project_id = t.project_id
      WHERE t.deleted_at IS NULL
        AND t.archived_at IS NULL
        AND p.deleted_at IS NULL
        AND t.updated_at >= ${toIso(nowMs - THREAD_WINDOW_MS)}
      ORDER BY t.updated_at DESC
      LIMIT 15
    `;
    const nowIso = toIso(nowMs);
    return rows.map((row): ContextThread => ({
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      updatedAt: row.updatedAt,
      status:
        row.waiting > 0
          ? "waiting on you"
          : row.settledAt !== null
            ? "settled"
            : row.snoozedUntil !== null && row.snoozedUntil > nowIso
              ? "snoozed"
              : "active",
      lastUserMessage: row.lastUserMessage,
      lastReply: row.lastReply,
    }));
  });

  /** This device's latest daily memory notes, when Memory is on. */
  const loadNotes = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    if (!settings.memoryEnabled) return [];
    const descriptor = yield* environment.getDescriptor;
    const vault = generalVaultPaths(path, config.memoryDir);
    const device = yield* findMemoryDevice(vault, descriptor.environmentId);
    if (!device) return [];
    const suffix = ` ${device.label}.md`;
    const days: string[] = [];
    const years = yield* fs.readDirectory(vault.daily).pipe(Effect.orElseSucceed(() => []));
    for (const year of years) {
      if (!/^\d{4}$/u.test(year)) continue;
      const names = yield* fs
        .readDirectory(path.join(vault.daily, year))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names) {
        const day = name.slice(0, name.length - suffix.length);
        if (name.endsWith(suffix) && /^\d{4}-\d{2}-\d{2}$/u.test(day)) days.push(day);
      }
    }
    const notes: ContextNote[] = [];
    for (const day of days.toSorted().toReversed().slice(0, NOTE_COUNT)) {
      const text = yield* fs
        .readFileString(path.join(vault.daily, day.slice(0, 4), `${day}${suffix}`))
        .pipe(Effect.option);
      if (Option.isSome(text)) notes.push({ day, text: text.value });
    }
    return notes;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.orElseSucceed((): ReadonlyArray<ContextNote> => []),
  );

  /** Recently changed documents and data files near the top of a project folder. */
  const loadProjectFiles = Effect.fn("ideas.loadProjectFiles")(function* (
    project: { readonly id: string; readonly workspaceRoot: string },
    nowMs: number,
  ) {
    const found: Array<ContextFile & { readonly modifiedMs: number }> = [];
    // A large folder must not hold up a request for ideas.
    let budget = PROJECT_SCAN_LIMIT;
    const walk = Effect.fn("Ideas.walk")(function* (
      directory: string,
      relative: string,
      depth: number,
    ): Effect.fn.Return<void> {
      const names = yield* fs
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of names.slice(0, DIRECTORY_ENTRY_LIMIT)) {
        if (budget <= 0) return;
        if (name.startsWith(".")) continue;
        budget--;
        const filePath = path.join(directory, name);
        const info = yield* fs.stat(filePath).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        const childRelative = relative.length > 0 ? `${relative}/${name}` : name;
        if (info.value.type === "Directory") {
          if (depth < 2 && !SKIPPED_DIRECTORIES.has(name)) {
            yield* walk(filePath, childRelative, depth + 1);
          }
          continue;
        }
        if (info.value.type !== "File") continue;
        if (!DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
        const modifiedMs = Option.isSome(info.value.mtime) ? info.value.mtime.value.getTime() : 0;
        if (nowMs - modifiedMs > FILE_WINDOW_MS) continue;
        found.push({
          projectId: project.id,
          path: childRelative,
          modifiedAt: toIso(modifiedMs),
          modifiedMs,
        });
      }
    });
    yield* walk(project.workspaceRoot, "", 0);
    return found
      .toSorted((left, right) => right.modifiedMs - left.modifiedMs)
      .slice(0, FILES_PER_PROJECT)
      .map((file): ContextFile => ({
        projectId: file.projectId,
        path: file.path,
        modifiedAt: file.modifiedAt,
      }));
  });

  /** Records first sightings and says which entries are new since Ideas started watching. */
  const markSeen = Effect.fn("ideas.markSeen")(function* (
    entryIds: ReadonlyArray<string>,
    nowMs: number,
  ) {
    const nowIso = toIso(nowMs);
    let baseline = yield* readState("catalog_baseline_at");
    if (baseline === null) {
      baseline = nowIso;
      yield* writeState("catalog_baseline_at", baseline);
    }
    for (const entryId of entryIds) {
      yield* sql`
        INSERT INTO idea_catalog_seen (entry_id, first_seen_at) VALUES (${entryId}, ${nowIso})
        ON CONFLICT (entry_id) DO NOTHING
      `;
    }
    const rows = yield* sql<{ readonly entryId: string; readonly firstSeenAt: string }>`
      SELECT entry_id AS "entryId", first_seen_at AS "firstSeenAt" FROM idea_catalog_seen
    `;
    const newSince = toIso(nowMs - NEW_WINDOW_MS);
    return new Set(
      rows
        .filter((row) => row.firstSeenAt > baseline && row.firstSeenAt >= newSince)
        .map((row) => row.entryId),
    );
  });

  const loadPlugins = listEnabledIntegrations;

  const loadSkills = Effect.gen(function* () {
    if (Option.isNone(skills)) return [];
    const read = yield* skills.value.readCatalog.pipe(
      Effect.timeoutOption(Duration.seconds(10)),
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(read) ? read.value.catalog.entries : [];
  });

  interface Exclusions {
    /** Keys that must not be suggested now: visible, used, rejected, or cooling down. */
    readonly excludedKeys: ReadonlySet<string>;
    /** Starter keys never hidden, so a first showing comes before a repeat. */
    readonly hiddenStarterKeys: ReadonlySet<string>;
    /** Hidden starter keys whose cooldown has ended, longest-hidden first. */
    readonly recyclableStarterKeys: ReadonlyArray<string>;
    readonly avoid: ReadonlyArray<string>;
    readonly weights: Record<IdeaSection, number>;
  }

  const loadExclusions = Effect.fn("ideas.loadExclusions")(function* (nowMs: number) {
    const rows = yield* sql<IdeaRow>`
      SELECT ${ideaColumns(sql)} FROM ideas ORDER BY updated_at DESC
    `;
    const permanent = new Set<string>();
    const permanentlyHidden = new Set<string>();
    const cooling = new Map<string, string>();
    const avoid: string[] = [];
    const cooldownStart = toIso(nowMs - DISMISS_COOLDOWN_MS);
    const avoidStart = toIso(nowMs - AVOID_WINDOW_MS);
    for (const row of rows) {
      if (row.status === "dismissed" || row.status === "expired") {
        const hiddenAt = row.hiddenAt ?? row.updatedAt;
        // A draft opened before the card was hidden may have been sent since. Check before its
        // cooldown lets the idea return, so a used idea stays used.
        if (row.openedAt !== null && hiddenAt < cooldownStart) {
          const content = decodeContent(row.contentJson);
          if (Option.isSome(content) && (yield* wasSent(row, content.value, row.openedAt))) {
            yield* retire(row, "sent", toIso(nowMs));
            permanent.add(row.ideaKey);
            permanentlyHidden.add(row.ideaKey);
            continue;
          }
        }
        const previous = cooling.get(row.ideaKey);
        if (previous === undefined || hiddenAt > previous) cooling.set(row.ideaKey, hiddenAt);
      } else {
        permanent.add(row.ideaKey);
        if (row.status === "sent" || row.status === "rejected") {
          permanentlyHidden.add(row.ideaKey);
        }
      }
    }
    const excludedKeys = new Set(permanent);
    for (const [key, hiddenAt] of cooling) {
      if (hiddenAt >= cooldownStart) excludedKeys.add(key);
    }
    // Permanent feedback keeps blocking rewordings regardless of age or recent-history size.
    // Other excluded ideas have a bounded title history; an ended cooldown allows a repeat.
    let recentTitles = 0;
    for (const row of rows) {
      const hiddenPermanently = permanentlyHidden.has(row.ideaKey);
      if (!hiddenPermanently && (recentTitles >= 60 || row.updatedAt < avoidStart)) continue;
      if (!excludedKeys.has(row.ideaKey)) continue;
      const content = decodeContent(row.contentJson);
      if (Option.isSome(content)) {
        avoid.push(content.value.title);
        if (!hiddenPermanently) recentTitles++;
      }
    }
    const recyclableStarterKeys = [...cooling.entries()]
      .filter(([key]) => key.startsWith("starter:") && !excludedKeys.has(key))
      .toSorted((left, right) => left[1].localeCompare(right[1]))
      .map(([key]) => key);
    const hiddenStarterKeys = new Set(
      [...cooling.keys()].filter((key) => key.startsWith("starter:")),
    );

    const feedbackStart = toIso(nowMs - FEEDBACK_WINDOW_MS);
    const counts = yield* sql<{
      readonly section: string;
      readonly kind: string;
      readonly count: number;
    }>`
      SELECT section, kind, COUNT(*) AS "count" FROM idea_feedback
      WHERE created_at >= ${feedbackStart}
      GROUP BY section, kind
    `;
    const sent = yield* sql<{ readonly section: string; readonly count: number }>`
      SELECT section, COUNT(*) AS "count" FROM ideas
      WHERE status = 'sent' AND updated_at >= ${feedbackStart}
      GROUP BY section
    `;
    const feedback = new Map<IdeaSection, SectionFeedback>();
    const entry = (section: IdeaSection) =>
      feedback.get(section) ?? { opened: 0, sent: 0, dismissed: 0, lessLikeThis: 0 };
    for (const row of counts) {
      if (!isSection(row.section)) continue;
      const current = entry(row.section);
      feedback.set(row.section, {
        ...current,
        opened: current.opened + (row.kind === "opened" ? row.count : 0),
        dismissed:
          current.dismissed + (row.kind === "dismissed" || row.kind === "rejected" ? row.count : 0),
        lessLikeThis: current.lessLikeThis + (row.kind === "less-like-this" ? row.count : 0),
      });
    }
    for (const row of sent) {
      if (!isSection(row.section)) continue;
      feedback.set(row.section, { ...entry(row.section), sent: row.count });
    }
    return {
      excludedKeys,
      hiddenStarterKeys,
      recyclableStarterKeys,
      avoid,
      weights: sectionWeights(feedback),
    } satisfies Exclusions;
  });

  const gatherContext = Effect.fn("ideas.gatherContext")(function* (
    nowMs: number,
    exclusions: Exclusions,
  ) {
    const projects = yield* loadProjects;
    const threads = yield* loadThreads(nowMs);
    const notes = yield* loadNotes;
    const files: ContextFile[] = [];
    for (const project of projects) {
      files.push(...(yield* loadProjectFiles(project, nowMs)));
    }
    const integrations = yield* loadPlugins;
    const entries = yield* loadSkills;
    const newIds = yield* markSeen(
      [
        ...integrations.map((integration) => `plugin:${integration.id}`),
        ...entries.map((entry) => `skill:${entry.id}`),
      ],
      nowMs,
    );
    const plugins = integrations.map((integration): ContextPlugin => ({
      id: integration.id,
      name: integration.name,
      description: integration.description,
      tools: integration.tools
        .filter((tool) => tool.available)
        .slice(0, 6)
        .map((tool) => tool.displayName),
      connected: !integration.requiresConnection || integration.connectionState === "connected",
      isNew: newIds.has(`plugin:${integration.id}`),
    }));
    const contextSkills = entries
      .map((entry): ContextSkill => ({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        isNew: newIds.has(`skill:${entry.id}`),
      }))
      .toSorted((left, right) => Number(right.isNew) - Number(left.isNew))
      .filter((skill, index) => skill.isNew || index < 12);
    return {
      today: localDayAt(nowMs),
      weights: exclusions.weights,
      projects: projects.map(({ id, title }) => ({ id, title })),
      threads,
      notes,
      files,
      plugins,
      skills: contextSkills,
      kinds: IDEA_KINDS,
      avoid: exclusions.avoid,
    } satisfies IdeasContext;
  });

  /** What each visible idea is about, so a new batch can't pile onto the same project or tool. */
  // Snoozed ideas keep their place, so waking them can't push a subject past the limit.
  const loadVisibleSubjects = Effect.gen(function* () {
    const rows = yield* sql<IdeaRow>`
      SELECT ${ideaColumns(sql)} FROM ideas WHERE status IN ('active', 'opened', 'snoozed')
    `;
    const subjects: string[] = [];
    for (const row of rows) {
      const content = decodeContent(row.contentJson);
      if (Option.isNone(content)) continue;
      const starter = STARTER_IDEAS.find((entry) => `starter:${entry.id}` === row.ideaKey);
      if (starter) {
        subjects.push(starterCandidate(starter).subject);
        continue;
      }
      const action = content.value.action;
      const projectId =
        action.kind === "new-thread"
          ? action.projectId
          : ((yield* sql<{ readonly projectId: string }>`
              SELECT project_id AS "projectId" FROM harness_activity_threads
              WHERE thread_id = ${action.threadId}
            `)[0]?.projectId ?? null);
      subjects.push(ideaSubject(row.ideaKey, projectId));
    }
    return subjects;
  });

  /** Counts a model call against today's limit; false when the limit is reached. */
  const takeModelCall = Effect.fn("ideas.takeModelCall")(function* (nowMs: number) {
    const today = localDayAt(nowMs);
    const stored = yield* readState("model_calls");
    const [day, count] = stored?.split("|") ?? [];
    const used = day === today ? Number(count) || 0 : 0;
    if (used >= DAILY_MODEL_CALLS) return false;
    yield* writeState("model_calls", `${today}|${used + 1}`);
    return true;
  });

  /** Starter ideas for empty slots: unshown ones first, then those whose cooldown ended. */
  const starterFill = (
    count: number,
    exclusions: Exclusions,
    taken: ReadonlySet<string>,
    connected: ReadonlySet<string>,
    subjects: ReadonlyArray<string>,
  ): CandidateIdea[] => {
    if (count <= 0) return [];
    const starters = availableStarters(connected);
    const fresh = starters.filter((starter) => {
      const key = `starter:${starter.id}`;
      return (
        !exclusions.excludedKeys.has(key) &&
        !exclusions.hiddenStarterKeys.has(key) &&
        !taken.has(key)
      );
    });
    const recycled = exclusions.recyclableStarterKeys.flatMap((key) => {
      const starter = starters.find((candidate) => `starter:${candidate.id}` === key);
      return starter && !taken.has(key) ? [starter] : [];
    });
    return capBySubject([...fresh, ...recycled].map(starterCandidate), subjects).slice(0, count);
  };

  /** Retires the oldest unopened ideas past the page's limit, starter ideas first. */
  const trim = Effect.fn("ideas.trim")(function* (nowIso: string) {
    const [row] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM ideas WHERE status IN ('active', 'opened')
    `;
    const excess = (row?.count ?? 0) - MAX_IDEAS;
    if (excess <= 0) return;
    yield* sql`
      UPDATE ideas SET status = 'expired', hidden_at = ${nowIso}, updated_at = ${nowIso}
      WHERE idea_id IN (
        SELECT idea_id FROM ideas WHERE status = 'active' AND created_at < ${nowIso}
        ORDER BY section = 'starter' DESC, created_at ASC
        LIMIT ${excess}
      )
    `;
  });

  /**
   * Adds up to `count` ideas. When the user asked for more, starter ideas fill
   * whatever the model could not, and the returned note says why; a background
   * run adds only what the model wrote.
   */
  const generateBatch = Effect.fn("ideas.generateBatch")(function* (
    count: number,
    requested: boolean,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* tidy(nowMs);
    const exclusions = yield* loadExclusions(nowMs);
    const context = yield* gatherContext(nowMs, exclusions);
    // With nothing of the user's own to go on, a background run would only pick more starter
    // ideas. It waits for activity instead, and stays due so the next check tries again.
    const personal =
      context.threads.length + context.notes.length + context.files.length + context.plugins.length;
    if (!requested && personal === 0) return null;

    let note: string | null = null;
    let outcome: "generated" | "no-model" | "daily-limit" | "failed" = "generated";
    let generated: CandidateIdea[] = [];
    const generateIdeas = textGeneration.generateIdeas;
    if (!generateIdeas) {
      outcome = "no-model";
      note = "Ideas need a Codex text generation model, so these are starter ideas.";
    } else if (!(yield* takeModelCall(nowMs))) {
      outcome = "daily-limit";
      note = "You've reached today's limit for new suggestions, so these are starter ideas.";
    } else {
      const settings = yield* settingsService.getSettings;
      const result = yield* generateIdeas({
        cwd: config.stateDir,
        count: count + 3,
        context: formatIdeasContext(context),
        modelSelection: settings.textGenerationModelSelection,
      }).pipe(
        // Its own scope for Codex's temporary files: a run started by Suggest more outlives the
        // request whose scope it would otherwise inherit.
        Effect.scoped,
        Effect.tapError((error) => Effect.logWarning("idea generation failed", { error })),
        Effect.option,
      );
      if (Option.isSome(result)) {
        generated = validateGeneratedIdeas({
          ideas: result.value.ideas,
          context,
          excludedKeys: exclusions.excludedKeys,
        });
      } else {
        outcome = "failed";
        note = "Couldn't personalize ideas just now, so these are starter ideas.";
      }
    }

    const visibleSubjects = yield* loadVisibleSubjects;
    const varied = capBySubject(generated, visibleSubjects);
    const picked = selectByMix(varied, count, exclusions.weights);
    const connected = new Set(
      context.plugins.filter((plugin) => plugin.connected).map((plugin) => plugin.id),
    );
    const fill = requested
      ? starterFill(
          count - picked.length,
          exclusions,
          new Set(picked.map((idea) => idea.key)),
          connected,
          [...visibleSubjects, ...picked.map((idea) => idea.subject)],
        )
      : [];
    const added = [...picked, ...fill];
    // Stamped after the model call, so a visit during the run doesn't hide them from the badge.
    const addedAt = toIso(yield* Clock.currentTimeMillis);
    yield* insertIdeas(added, addedAt);
    yield* trim(addedAt);
    yield* writeState("last_generated_at", addedAt);
    yield* writeState("activity_fingerprint", yield* activityFingerprint);
    yield* track("ideas.generated", {
      requested,
      outcome,
      generatedCount: picked.length,
      starterCount: fill.length,
    });
    if (!requested) return null;
    if (added.length === 0) {
      return "You've seen every idea for now. Dismissed ideas come back after two weeks.";
    }
    return picked.length === 0 ? note : null;
  });

  const generate = (count: number, requested: boolean) =>
    lock.withPermits(1)(
      setGenerationStatus({ state: "generating", message: null }).pipe(
        Effect.andThen(generateBatch(count, requested)),
        Effect.flatMap((message) => setGenerationStatus({ state: "idle", message })),
        Effect.catchCause((cause) =>
          setGenerationStatus({
            state: "error",
            message: "Couldn't load new ideas. Try again in a moment.",
          }).pipe(
            Effect.andThen(
              Effect.logWarning("idea generation failed", { cause: Cause.pretty(cause) }),
            ),
          ),
        ),
      ),
    );

  /** Changes when a thread message is added or finishes, so idle days skip the model. */
  const activityFingerprint = sql<{ readonly count: number; readonly latest: string | null }>`
    SELECT COUNT(*) AS "count", MAX(updated_at) AS "latest" FROM harness_activity_messages
    WHERE is_streaming = 0
  `.pipe(Effect.map(([row]) => `${row?.count ?? 0}:${row?.latest ?? ""}`));

  /** How many ideas a refresh would add now, or null when the page is fresh enough. */
  const refreshCount = Effect.fn("ideas.refreshCount")(function* (nowMs: number) {
    const lastGeneratedAt = yield* readState("last_generated_at");
    if (lastGeneratedAt !== null && nowMs - Date.parse(lastGeneratedAt) < REFRESH_AFTER_MS) {
      return null;
    }
    yield* tidy(nowMs);
    const [row] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM ideas WHERE status IN ('active', 'opened')
    `;
    const visible = row?.count ?? 0;
    const changed = (yield* readState("activity_fingerprint")) !== (yield* activityFingerprint);
    // Thread activity is cheap to watch; files, notes, and tools are picked up at least daily.
    const dayOld =
      lastGeneratedAt === null || nowMs - Date.parse(lastGeneratedAt) >= DAILY_REFRESH_MS;
    if (visible >= TARGET_IDEAS && !changed && !dayOld) return null;
    return Math.max(2, TARGET_IDEAS - visible);
  });

  const refresh = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const lastViewedAt = yield* readState("last_viewed_at");
    if (lastViewedAt === null || nowMs - Date.parse(lastViewedAt) > VIEW_WINDOW_MS) return;
    const count = yield* refreshCount(nowMs);
    if (count !== null) yield* generate(count, false);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("idea refresh failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const startGeneration = (requested: boolean, count: number = SUGGEST_MORE_COUNT) =>
    generate(count, requested).pipe(
      Effect.forkIn(scope),
      Effect.flatMap((fiber) => Ref.set(running, fiber)),
    );

  const toIdeasError = (message: string) => (error: unknown) =>
    Effect.logWarning(message, { error }).pipe(
      Effect.andThen(Effect.fail(new IdeasError({ message }))),
    );

  const list = snapshot.pipe(Effect.catch(toIdeasError("Couldn't load ideas.")));

  const markViewed = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const previousView = yield* readState("last_viewed_at");
    yield* writeState("last_viewed_at", toIso(nowMs));
    const result = yield* snapshot;
    // The page marks itself viewed again as new ideas arrive; only a return after a gap is a visit.
    if (previousView === null || nowMs - Date.parse(previousView) >= VISIT_GAP_MS) {
      const count = (sections: ReadonlyArray<IdeaSection>) =>
        result.ideas.filter((idea) => sections.includes(idea.section)).length;
      yield* track("ideas.viewed", {
        visibleCount: result.ideas.length,
        personalCount: count(["continue", "projects"]),
        toolCount: count(["tools", "new"]),
        starterCount: count(["starter"]),
      });
    }
    if (result.state === "generating") return result;
    // A first visit shows the starter ideas at once and personal ones as soon as they are ready.
    // A later visit to a stale page checks for new ideas then, instead of waiting for the hourly check.
    const count =
      (yield* readState("last_generated_at")) === null
        ? SUGGEST_MORE_COUNT
        : yield* refreshCount(nowMs);
    if (count === null) return result;
    yield* setGenerationStatus({ state: "generating", message: null });
    yield* startGeneration(false, count);
    return { ...(yield* snapshot), state: "generating" as const };
  }).pipe(Effect.catch(toIdeasError("Couldn't load ideas.")));

  const suggestMore = Effect.gen(function* () {
    if ((yield* Ref.get(status)).state !== "generating") {
      yield* setGenerationStatus({ state: "generating", message: null });
      yield* startGeneration(true);
    }
    return yield* snapshot;
  }).pipe(Effect.catch(toIdeasError("Couldn't load more ideas.")));

  // One press at a time: each reads an idea and then changes it, and two clients
  // pressing at once must not overwrite each other.
  /**
   * Applies one press to the idea as just read. Returns false when the idea
   * changed underneath it, such as a background run retiring it, so the caller
   * reads it again and retries.
   */
  const applyFeedback = Effect.fn("ideas.applyFeedback")(function* (
    input: IdeasFeedbackInput,
    row: IdeaRow,
    nowIso: string,
  ) {
    const visible = row.status === "active" || row.status === "opened";
    switch (input.kind) {
      case "opened": {
        if (!visible) return true;
        // Opening again must not erase the evidence that the first draft was sent.
        if (row.openedAt !== null) {
          const content = decodeContent(row.contentJson);
          if (Option.isSome(content) && (yield* wasSent(row, content.value, row.openedAt))) {
            yield* retire(row, "sent", nowIso);
            return true;
          }
        }
        // The first open stays the start of tracking; reopening restarts only the timeout.
        if (!(yield* setStatus(row, "opened", nowIso, { openedAt: row.openedAt ?? nowIso }))) {
          return false;
        }
        // The thread's messages at the first open are the ones a later send is not.
        const content = decodeContent(row.contentJson);
        if (
          row.openedMessageIdsJson === null &&
          Option.isSome(content) &&
          content.value.action.kind === "resume-thread"
        ) {
          yield* sql`
            UPDATE ideas SET opened_message_ids_json = (
              SELECT json_group_array(message_id) FROM harness_activity_messages
              WHERE thread_id = ${content.value.action.threadId} AND role = 'user'
            )
            WHERE idea_id = ${row.ideaId} AND opened_message_ids_json IS NULL
          `;
        }
        // Each client keeps its own draft; sending any of them uses the idea. One statement
        // appends, so two clients opening at once both keep their drafts.
        if (input.draftThreadId !== undefined) {
          yield* sql`
            UPDATE ideas
            SET draft_thread_ids_json =
              json_insert(COALESCE(draft_thread_ids_json, '[]'), '$[#]', ${input.draftThreadId})
            WHERE idea_id = ${row.ideaId}
              AND NOT EXISTS (
                SELECT 1 FROM json_each(COALESCE(draft_thread_ids_json, '[]'))
                WHERE value = ${input.draftThreadId}
              )
          `;
        }
        if (row.status === "active") yield* recordFeedback(row, "opened", nowIso);
        return true;
      }
      case "rejected": {
        // Not relevant means never again, even if the card was retired in the meantime.
        if (row.status === "rejected" || row.status === "sent" || row.status === "snoozed") {
          return true;
        }
        const applied = yield* setStatus(row, "rejected", nowIso, {
          previousStatus: visible ? row.status : null,
          hiddenAt: nowIso,
        });
        if (applied) yield* recordFeedback(row, "rejected", nowIso);
        return applied;
      }
      case "dismissed":
      case "less-like-this": {
        // A card already out of view stays hidden; Less like this still counts toward the mix.
        if (!visible) {
          if (input.kind === "less-like-this") yield* recordFeedback(row, input.kind, nowIso);
          return true;
        }
        const applied = yield* setStatus(row, "dismissed", nowIso, {
          previousStatus: row.status,
          hiddenAt: nowIso,
        });
        if (applied) yield* recordFeedback(row, input.kind, nowIso);
        return applied;
      }
      case "snoozed": {
        if (!visible) return true;
        if (input.snoozedUntil === undefined || input.snoozedUntil <= nowIso) {
          return yield* new IdeasError({ message: "Choose a time in the future." });
        }
        const applied = yield* setStatus(row, "snoozed", nowIso, {
          previousStatus: row.status,
          snoozedUntil: input.snoozedUntil,
        });
        if (applied) yield* recordFeedback(row, "snoozed", nowIso);
        return applied;
      }
      case "restored": {
        if (row.status !== "dismissed" && row.status !== "rejected" && row.status !== "snoozed") {
          return true;
        }
        if (!(yield* setStatus(row, row.previousStatus ?? "active", nowIso, {}))) return false;
        // Undo takes back the press, so it no longer moves the mix of sections.
        yield* sql`
          DELETE FROM idea_feedback WHERE rowid = (
            SELECT rowid FROM idea_feedback
            WHERE idea_id = ${row.ideaId}
              AND kind IN ('dismissed', 'rejected', 'less-like-this', 'snoozed')
            ORDER BY created_at DESC LIMIT 1
          )
        `;
        return true;
      }
    }
  });

  // One press at a time: each reads an idea and then changes it, and two clients
  // pressing at once must not overwrite each other. A background change between the
  // read and the write sends the press around again on the idea as it now is.
  const feedback = (input: IdeasFeedbackInput) =>
    feedbackLock
      .withPermits(1)(
        Effect.gen(function* () {
          const nowIso = toIso(yield* Clock.currentTimeMillis);
          for (let attempt = 0; attempt < 3; attempt++) {
            const [row] = yield* sql<IdeaRow>`
              SELECT ${ideaColumns(sql)} FROM ideas WHERE idea_id = ${input.ideaId}
            `;
            if (!row) {
              return yield* new IdeasError({ message: "That idea is no longer available." });
            }
            if (yield* applyFeedback(input, row, nowIso)) return yield* snapshot;
          }
          return yield* new IdeasError({ message: "That idea changed. Try again." });
        }),
      )
      .pipe(
        Effect.catch((error) =>
          isIdeasError(error)
            ? Effect.fail(error)
            : toIdeasError("Couldn't save that change.")(error),
        ),
      );

  return Ideas.of({
    list,
    markViewed,
    suggestMore,
    feedback,
    refresh,
    awaitIdle: Ref.get(running).pipe(
      Effect.flatMap((fiber) => (fiber ? Fiber.await(fiber) : Effect.void)),
      Effect.andThen(lock.withPermits(1)(Effect.void)),
    ),
  });
});

/** Checks every hour whether the ideas need refreshing. */
export const layer = Layer.effect(
  Ideas,
  Effect.gen(function* () {
    const service = yield* make;
    yield* Effect.sleep(STARTUP_DELAY).pipe(
      Effect.andThen(service.refresh.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)))),
      Effect.forkScoped,
    );
    return service;
  }),
);
