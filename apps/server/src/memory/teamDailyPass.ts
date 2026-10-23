// @effect-diagnostics nodeBuiltinImport:off - Synchronous SHA-256 document fingerprints and campus identity keys use Node crypto.
/**
 * The team pass of daily memory: writes this device's daily file in each team its campus account
 * belongs to, from work in this environment's projects linked to that team. DailyMemory runs it
 * after each personal catch-up and when a thread's sharing changes (see `DailyMemory.ts`).
 *
 * Only team work reaches the model: `loadDayActivity` is given the team's scope, so the query
 * itself is limited to linked projects, to work after each link began sharing, and to threads not
 * chosen as Don't share. It follows personal memory's rhythm: finished days up to a week back are
 * summarized once, and today at most every four hours while it changes. Then:
 *
 * - summaries for threads or projects that stopped qualifying while the model ran are dropped;
 * - every day file whose content changed is rendered (see `teamDaily.ts`) and written through the
 *   Teams side, which checks the account, membership, and links again first.
 *
 * The record keeps what each published file says, for as long as the file exists, so choosing
 * Don't share later still rewrites old files. It holds summaries only, never transcripts. Access
 * that ended clears the team's record and writes nothing more; published files stay with the
 * team. Access that couldn't be checked holds everything for a later pass. Signing out keeps the
 * record unused until the same account signs in again; another account's sign-in sets it aside
 * for its own account and never reads or writes with it.
 */
import { TextGenerationError } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type { TextGeneration } from "../textGeneration/TextGeneration.ts";
import {
  type ActivityExtent,
  hasStreamingMessages,
  loadDayActivity,
  type TeamActivityScope,
} from "./memoryActivity.ts";
import { addLocalDays, localDayAt, localDayRange } from "./memoryDays.ts";
import { formatMemoryActivity, type MemoryThreadActivity } from "./memoryNotes.ts";
import {
  renderTeamDailyFile,
  renderTeamDailySection,
  sha256,
  TeamDailyMarker,
  teamDailyMarkerPath,
  teamDailyPath,
  type TeamDailyDay,
  TeamDailyState,
  type TeamDailyThreadNow,
  type Writable,
} from "./teamDaily.ts";
import type {
  TeamDailyAccount,
  TeamDailySource,
  TeamDailyStatus,
  TeamDailyWorkspace,
} from "./teamDailySource.ts";

/** Threads one model call summarizes; a busier day takes more calls. */
const THREADS_PER_CALL = 12;

type State = Writable<TeamDailyState>;
type Day = Writable<TeamDailyDay>;
type Team = State["teams"][string];
type Activity = MemoryThreadActivity & ActivityExtent;

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(TeamDailyState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(TeamDailyState));
const encodeMarker = Schema.encodeEffect(Schema.fromJsonString(TeamDailyMarker));

/** How each of `threadIds` stands now, deleted threads included. */
const threadsNow = Effect.fn("teamMemory.threadsNow")(function* (threadIds: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  const threads = new Map<string, TeamDailyThreadNow>();
  for (let index = 0; index < threadIds.length; index += 500) {
    const rows = yield* sql<{
      readonly threadId: string;
      readonly projectId: string;
      readonly deletedAt: string | null;
      readonly offAt: string | null;
      readonly resumedAt: string | null;
    }>`
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        deleted_at AS "deletedAt",
        team_sharing_off_at AS "offAt",
        team_sharing_resumed_at AS "resumedAt"
      FROM harness_activity_threads
      WHERE ${sql.in("thread_id", threadIds.slice(index, index + 500))}
    `;
    for (const row of rows)
      threads.set(row.threadId, {
        projectId: row.projectId,
        deleted: row.deletedAt !== null,
        off: row.offAt !== null,
        resumedAt: row.resumedAt,
      });
  }
  return threads;
});
const sameThread = (a: TeamDailyThreadNow | undefined, b: TeamDailyThreadNow | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.projectId === b.projectId &&
  a.deleted === b.deleted &&
  a.off === b.off &&
  a.resumedAt === b.resumedAt;

const scopeOf = (workspace: TeamDailyWorkspace): TeamActivityScope => ({
  projects: new Map(workspace.projects.map((p) => [p.projectId, p.sharingSince])),
});

export const makeTeamDailyPass = Effect.fn("teamMemory.makeTeamDailyPass")(function* (input: {
  readonly stateDir: string;
  readonly deviceLabel: string;
  readonly settings: ServerSettingsService["Service"];
  readonly textGeneration: TextGeneration["Service"];
  /** Same rhythm as personal memory. */
  readonly maxCatchUpDays: number;
  readonly partialIntervalMs: number;
  readonly streamingGraceMs: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  const source = yield* Ref.make<TeamDailySource | null>(null);
  const statuses = new Map<string, TeamDailyStatus>();
  const directory = path.join(input.stateDir, "team-daily");
  const stateFile = path.join(directory, "state.json");

  const provide = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((ms) => DateTime.formatIso(DateTime.makeUnsafe(ms))),
  );

  /**
   * Where an account's record waits while another account is signed in here: outside
   * `directory`, which the model runs in, so it never sees another account's summaries.
   */
  const setAsideFile = (author: string) =>
    path.join(input.stateDir, "team-daily-accounts", `${sha256(author)}.json`);

  const readStateAt = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.flatMap(decodeState),
      Effect.map((state) => Option.some(structuredClone(state) as State)),
      // A missing or unreadable record starts over: a fresh record publishes nothing old.
      Effect.orElseSucceed(() => Option.none<State>()),
    );
  const readState = readStateAt(stateFile);
  const writeStateAt = (file: string, state: State) =>
    encodeState(state).pipe(
      Effect.flatMap((contents) =>
        fs
          .makeDirectory(path.dirname(file), { recursive: true })
          .pipe(Effect.andThen(writeFileStringAtomically({ filePath: file, contents }))),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const writeState = (state: State) => writeStateAt(stateFile, state);
  const teamsEnabled = input.settings.getSettings.pipe(
    Effect.map((settings) => settings.experimentalTeamsEnabled),
    Effect.orElseSucceed(() => false),
  );
  const sharingEnabled = input.settings.getSettings.pipe(
    Effect.map((settings) => settings.memoryEnabled && settings.experimentalTeamsEnabled),
    Effect.orElseSucceed(() => false),
  );

  const setStatus = (teamId: string, next: Partial<TeamDailyStatus>) =>
    Effect.sync(() => {
      const current = statuses.get(teamId);
      statuses.set(teamId, {
        state: next.state ?? current?.state ?? "sharing",
        message: next.message !== undefined ? next.message : (current?.message ?? null),
        lastPublishedAt: next.lastPublishedAt ?? current?.lastPublishedAt ?? null,
      });
    });

  /** Each thread's section for `day`, summarized through the model in batches. */
  const summarize = Effect.fn("teamMemory.summarize")(function* (
    day: string,
    teamName: string,
    threads: ReadonlyArray<Activity>,
  ) {
    const generate = input.textGeneration.generateTeamDailyMemory;
    if (!generate)
      return yield* new TextGenerationError({
        operation: "generateTeamDailyMemory",
        detail: "Team memory needs a Codex text generation model.",
      });
    const settings = yield* input.settings.getSettings;
    const sections = new Map<string, string>();
    for (let index = 0; index < threads.length; index += THREADS_PER_CALL) {
      // Memory turned off: no more activity reaches the model, and nothing is recorded.
      if (!(yield* sharingEnabled)) return null;
      const keyed = threads
        .slice(index, index + THREADS_PER_CALL)
        .map((thread, offset) => ({ key: `T${offset + 1}`, thread }));
      const result = yield* generate({
        cwd: directory,
        day,
        teamName,
        threads: keyed.map(({ key, thread }) => ({
          key,
          activity: formatMemoryActivity(
            [thread],
            new Map([[thread.projectId, thread.projectTitle]]),
          ),
        })),
        modelSelection: settings.textGenerationModelSelection,
      });
      for (const { key, thread } of keyed) {
        const summary = result.threads.find((entry) => entry.key === key);
        sections.set(
          thread.threadId,
          renderTeamDailySection({
            threadId: thread.threadId,
            title: thread.title,
            projectTitle: thread.projectTitle,
            firstAt: thread.firstAt,
            lastAt: thread.lastAt,
            branch: thread.branch,
            pullRequestUrl: thread.pullRequestUrl,
            summary: summary?.summary ?? "",
            items: summary?.items ?? [],
          }),
        );
      }
    }
    return sections;
  });

  const workspaceOf = (account: TeamDailyAccount, teamId: string) =>
    account.kind === "signed-in"
      ? account.workspaces.find((workspace) => workspace.teamId === teamId)
      : undefined;

  /**
   * Summarizes the days that need it for one team and keeps only sections that still qualify
   * once the model is done. Returns false when the team must be left alone this pass.
   */
  const summarizeTeam = Effect.fn("teamMemory.summarizeTeam")(function* (
    attached: TeamDailySource,
    state: State,
    team: Team,
    workspace: TeamDailyWorkspace,
    authorName: string,
    nowMs: number,
  ) {
    const scope = scopeOf(workspace);
    if (scope.projects.size === 0) return true;
    const today = localDayAt(nowMs);
    const earliest = addLocalDays(today, -input.maxCatchUpDays);
    const firstShared = localDayAt(Date.parse([...scope.projects.values()].toSorted()[0]!));
    const streamingSince = DateTime.formatIso(DateTime.makeUnsafe(nowMs - input.streamingGraceMs));
    const days: Array<{ day: string; status: "partial" | "final" }> = [];
    let day = team.lastFinishedDay ? addLocalDays(team.lastFinishedDay, 1) : earliest;
    for (const floor of [earliest, firstShared]) if (day < floor) day = floor;
    for (; day < today; day = addLocalDays(day, 1)) days.push({ day, status: "final" });
    const todayRecord = team.days[today];
    if (!todayRecord || nowMs - Date.parse(todayRecord.summarizedAt) >= input.partialIntervalMs)
      days.push({ day: today, status: "partial" });

    for (const entry of days) {
      if (!(yield* sharingEnabled)) return true;
      const range = localDayRange(entry.day);
      // A turn still being written would be summarized without its result.
      if (yield* provide(hasStreamingMessages(range, streamingSince, scope))) return true;
      const activity = yield* provide(loadDayActivity(range, scope));
      const summarizedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
      const record: Day = team.days[entry.day] ?? {
        sections: {},
        etag: null,
        publishedSha: null,
        status: entry.status,
        summarizedAt,
        authorName,
        deviceLabel: input.deviceLabel,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      const changed = activity.filter(
        (thread) => record.sections[thread.threadId]?.fingerprint !== thread.fingerprint,
      );
      if (changed.length > 0) {
        yield* setStatus(workspace.teamId, { message: `Summarizing ${entry.day}.` });
        const summaries = yield* summarize(entry.day, workspace.teamName, changed);
        if (summaries === null || !(yield* sharingEnabled)) return true;
        // Anything that stopped qualifying while the model ran is dropped, not recorded.
        const after = yield* attached.account([workspace.teamId]);
        const fresh = workspaceOf(after, workspace.teamId);
        if (after.kind !== "signed-in" || after.author !== state.author || !fresh) return false;
        if (fresh.access !== "ready") return false;
        // Memory turned off while the model ran: nothing new is recorded for the team.
        if (!(yield* sharingEnabled)) return true;
        const stillLinked = scopeOf(fresh).projects;
        const now = yield* provide(threadsNow(changed.map((t) => t.threadId)));
        for (const thread of changed) {
          const text = summaries.get(thread.threadId);
          const linkSince = scope.projects.get(thread.projectId)!;
          const current = now.get(thread.threadId);
          // The thread must still exist, in the same project, shared as it was when read.
          if (
            text === undefined ||
            current === undefined ||
            current.off ||
            current.projectId !== thread.projectId ||
            current.resumedAt !== thread.sharingResumedAt ||
            stillLinked.get(thread.projectId) !== linkSince
          )
            continue;
          const previous = record.sections[thread.threadId];
          const sameGeneration = (previous?.sharing ?? null) === thread.sharingResumedAt;
          // An unconfirmed write may have carried an earlier generation to the team.
          const attempted = record.attempt?.included[thread.threadId] !== undefined;
          const attemptedGeneration =
            record.attempt?.generations && thread.threadId in record.attempt.generations
              ? record.attempt.generations[thread.threadId]
              : (previous?.sharing ?? null);
          record.sections[thread.threadId] = {
            projectId: thread.projectId,
            sharing: thread.sharingResumedAt,
            linkSince,
            text,
            // Text published under an earlier sharing generation was withdrawn by Don't
            // share; it is never this section's baseline, so it can't be published again,
            // but its removal stays owed until a file without it is confirmed.
            publishedText: sameGeneration ? (previous?.publishedText ?? null) : null,
            ...(previous?.owesRemoval === true ||
            (!sameGeneration && (previous?.publishedText ?? null) !== null) ||
            (attempted && attemptedGeneration !== thread.sharingResumedAt)
              ? { owesRemoval: true }
              : {}),
            startedAt: thread.firstAt,
            fingerprint: thread.fingerprint,
          };
        }
      }
      if (Object.keys(record.sections).length > 0)
        team.days[entry.day] = { ...record, status: entry.status, summarizedAt };
      if (entry.status === "final") team.lastFinishedDay = entry.day;
      yield* writeState(state);
    }
    return true;
  });

  /** A confirmed late write must be announced after a teammate could have scanned its attempt. */
  const advanceMonth = Effect.fn("teamMemory.advanceMonth")(function* (team: Team, day: string) {
    const marker = (team.marker ??= { months: {}, publishedSha: null, etag: null });
    const month = day.slice(0, 7);
    const now = yield* Clock.currentTimeMillis;
    const previous = Date.parse(marker.months[month] ?? "");
    marker.months[month] = DateTime.formatIso(
      DateTime.makeUnsafe(Number.isFinite(previous) ? Math.max(now, previous + 1) : now),
    );
  });

  /** Publishes the team's change marker, in the team's current folder, when it changed. */
  const publishMarker = Effect.fn("teamMemory.publishMarker")(function* (
    attached: TeamDailySource,
    state: State,
    team: Team,
    workspace: TeamDailyWorkspace,
    privacyCleanup: boolean,
  ) {
    const current = team.marker;
    if (!(yield* teamsEnabled) && !privacyCleanup) return "done" as const;
    if (!current) return "done" as const;
    // Bound before the first write, like day files: the marker is only updated where it is.
    if ((current.storageKey ?? null) === null) {
      if (workspace.storageKey === null) return "done" as const;
      current.storageKey = workspace.storageKey;
      yield* writeState(state);
    }
    if (Object.keys(current.months).length === 0) return "done" as const;
    const text = yield* encodeMarker({
      version: 1,
      months: Object.fromEntries(Object.entries(current.months).toSorted()),
    });
    const sha = sha256(text);
    if (sha === current.publishedSha) return "done" as const;
    const result = yield* attached.write({
      teamId: workspace.teamId,
      author: state.author,
      path: teamDailyMarkerPath(state.author, state.deviceId),
      text,
      etag: current.etag,
      storageKey: current.storageKey ?? null,
      freshProjects: [],
      stillShared: privacyCleanup ? Effect.succeed(true) : teamsEnabled,
      ...(privacyCleanup ? { privacyCleanup: true as const } : {}),
    });
    if (result.kind === "lost") return "lost" as const;
    if (result.kind === "held" || result.kind === "rejected" || result.kind === "changed") {
      yield* setStatus(workspace.teamId, { state: "held", message: result.message });
      return "held" as const;
    }
    current.publishedSha = sha;
    current.etag = result.etag;
    current.storageKey = result.storageKey;
    yield* writeState(state);
    return "done" as const;
  });

  /**
   * Settles a write whose outcome isn't known by reading the file where it was written. Returns
   * false when that can't be learned now, so the day is left as it is.
   */
  const settleAttempt = Effect.fn("teamMemory.settleAttempt")(function* (
    attached: TeamDailySource,
    state: State,
    team: Team,
    record: Day,
    day: string,
    teamId: string,
    privacyCleanup: boolean,
  ) {
    const attempt = record.attempt;
    if (!attempt) return "settled" as const;
    const found = yield* attached.inspect({
      teamId,
      author: state.author,
      path: teamDailyPath(state.author, day, state.deviceId),
      storageKey: record.storageKey ?? null,
    });
    if (found.kind === "lost") return "lost" as const;
    if (found.kind === "held") return "held" as const;
    let confirmedChange = false;
    if (found.kind === "file" && sha256(found.text) === attempt.sha) {
      confirmedChange = true;
      // The write landed: what it carried is now what the team has.
      for (const [threadId, section] of Object.entries(record.sections)) {
        const text = attempt.included[threadId];
        // Left out of the file, so no earlier generation of it is there either.
        if (text === undefined) delete section.owesRemoval;
        else if (
          (section.sharing ?? null) ===
          (attempt.generations && threadId in attempt.generations
            ? attempt.generations[threadId]
            : (section.sharing ?? null))
        ) {
          section.publishedText = text;
          delete section.owesRemoval;
        } else {
          // An earlier generation's text landed: the team has it, so its removal is owed.
          section.owesRemoval = true;
        }
      }
      record.publishedSha = attempt.sha;
      record.etag = found.etag;
    } else if (found.kind === "missing") {
      // An old unversioned content create can still land after this read. New writes may
      // only create empty reservations; their conditional memory updates can't recreate it.
      if (
        attempt.sha !== null &&
        !attempt.confirmedUnsent &&
        !attempt.conditional &&
        record.etag === null
      )
        return "held" as const;
      confirmedChange = attempt.sha === null || record.publishedSha !== null;
      // A removal landed, or nothing was ever written.
      for (const section of Object.values(record.sections)) delete section.owesRemoval;
      if (attempt.sha === null)
        for (const section of Object.values(record.sections)) section.publishedText = null;
      record.publishedSha = null;
      record.etag = null;
    } else if (
      (record.publishedSha !== null && sha256(found.text) === record.publishedSha) ||
      (attempt.conditional && found.text === "")
    ) {
      if (attempt.confirmedUnsent) {
        record.etag = found.etag;
        record.publishedSha = sha256(found.text);
      } else {
        // Old pilot creates carried content without a version precondition. Removing their
        // file could let them recreate it later; retain that legacy obligation.
        if (!attempt.conditional && record.etag === null) return "held" as const;
        // A read alone cannot fence an unanswered update. A confirmed conditional removal
        // invalidates its old ETag, even if it arrives after this day is recreated. Preserve
        // the local baseline so the normal render restores only still-shared work.
        const fenced = yield* attached.write({
          teamId,
          author: state.author,
          path: teamDailyPath(state.author, day, state.deviceId),
          text: null,
          etag: found.etag,
          storageKey: record.storageKey ?? null,
          freshProjects: [],
          stillShared: privacyCleanup ? Effect.succeed(true) : teamsEnabled,
          ...(privacyCleanup ? { privacyCleanup: true as const } : {}),
        });
        if (fenced.kind === "lost") return "lost" as const;
        if (fenced.kind !== "written") return "held" as const;
        record.etag = null;
        record.publishedSha = null;
        confirmedChange = true;
      }
    } else {
      // Someone changed the file, so it can't be known whether the write landed. Nothing is
      // assumed published or unpublished: the day waits, with its attempt kept, until the
      // file matches a known version again or is removed.
      return "ambiguous" as const;
    }
    delete record.attempt;
    if (confirmedChange) {
      yield* advanceMonth(team, day);
      yield* setStatus(teamId, { lastPublishedAt: yield* nowIso });
    }
    yield* writeState(state);
    return "settled" as const;
  });

  /**
   * Writes every day file whose content changed. A day that can't be written now is reported
   * and skipped, so it never holds back other days, withdrawals, or the change marker.
   */
  const publishTeam = Effect.fn("teamMemory.publishTeam")(function* (
    attached: TeamDailySource,
    state: State,
    team: Team,
    workspace: TeamDailyWorkspace,
  ) {
    const linkedProjects = scopeOf(workspace).projects;
    // A folder that changed starts a new marker there; the old folder's files stay put.
    if (
      team.marker?.storageKey &&
      workspace.storageKey &&
      team.marker.storageKey !== workspace.storageKey
    )
      team.marker = { months: {}, publishedSha: null, etag: null, storageKey: null };
    const threads = yield* provide(
      threadsNow([
        ...new Set(Object.values(team.days).flatMap((day) => Object.keys(day.sections))),
      ]),
    );
    const problems: string[] = [];
    let cleanedUp = false;
    for (const day of Object.keys(team.days).toSorted()) {
      const record = team.days[day]!;
      /**
       * Says so when the team's file may still hold a thread chosen as Don't share: one whose
       * earlier generation was published or may have been sent, or a withdrawn one the team
       * has or may have. It holds until a file without it is confirmed.
       */
      const withRemoval = (message: string) => {
        const withdrawn = renderTeamDailyFile(
          record,
          { day, author: state.author },
          { threads, linkedProjects },
        ).withdrawn;
        const owed = Object.entries(record.sections).some(
          ([threadId, section]) =>
            section.owesRemoval === true ||
            (withdrawn.includes(threadId) &&
              (section.publishedText !== null || record.attempt?.included[threadId] !== undefined)),
        );
        return owed
          ? `${message} A thread you chose not to share may still be in it; remove it in SharePoint, or ask your administrator.`
          : message;
      };
      // A file is only ever updated, checked, or removed in the folder it was first sent to.
      if ((record.storageKey ?? null) !== null && record.storageKey !== workspace.storageKey) {
        problems.push(
          withRemoval(
            `Your shared memory for ${day} is in the team's previous folder, so Harness can't update or remove it there. Ask your administrator.`,
          ),
        );
        continue;
      }
      // Pausing Teams preserves remote files and uncertain writes. Only a thread whose
      // sharing was withdrawn can require remote work while the feature is off.
      const before = renderTeamDailyFile(
        record,
        { day, author: state.author },
        { threads, linkedProjects, publishedOnly: true },
      );
      const owesWithdrawal = Object.entries(record.sections).some(
        ([threadId, section]) =>
          section.owesRemoval === true ||
          (before.withdrawn.includes(threadId) &&
            (section.publishedText !== null || record.attempt?.included[threadId] !== undefined)),
      );
      if (!(yield* teamsEnabled) && !owesWithdrawal) continue;
      const settled = yield* settleAttempt(
        attached,
        state,
        team,
        record,
        day,
        workspace.teamId,
        owesWithdrawal,
      );
      if (settled === "settled" && owesWithdrawal) cleanedUp = true;
      if (settled === "lost") return "lost" as const;
      if (settled === "held") {
        problems.push(
          withRemoval(`Harness couldn't confirm whether ${day} was saved; it will check again.`),
        );
        continue;
      }
      if (settled === "ambiguous") {
        problems.push(
          withRemoval(
            `Your shared memory for ${day} was changed in SharePoint, so Harness can't tell what it holds and won't change it.`,
          ),
        );
        continue;
      }
      // While Memory is off, files may lose content but gain none.
      const allowFresh = yield* sharingEnabled;
      const rendered = renderTeamDailyFile(
        record,
        { day, author: state.author },
        { threads, linkedProjects, publishedOnly: !allowFresh },
      );
      // Sharing a thread again resummarizes it; unpublished text that can no longer be
      // published leaves for good; a thread that no longer qualifies keeps only what was
      // published.
      let changed = false;
      // A withdrawn or dropped section the team may have is kept, though never shown, until
      // a write that leaves it out is confirmed: until then, its removal is owed and reported.
      const owedRemovals = [...rendered.withdrawn, ...rendered.dropped].filter(
        (threadId) =>
          record.sections[threadId]?.publishedText != null ||
          record.sections[threadId]?.owesRemoval === true,
      );
      for (const threadId of [...rendered.withdrawn, ...rendered.dropped]) {
        if (owedRemovals.includes(threadId)) continue;
        delete record.sections[threadId];
        changed = true;
      }
      /** The team's file is confirmed to be `rendered`, which holds no earlier generation. */
      const settleRemovals = () => {
        for (const threadId of owedRemovals) delete record.sections[threadId];
        let settled = owedRemovals.length > 0;
        for (const section of Object.values(record.sections))
          if (section.owesRemoval !== undefined) {
            delete section.owesRemoval;
            settled = true;
          }
        return settled;
      };
      for (const threadId of rendered.frozen) {
        const section = record.sections[threadId]!;
        section.text = section.publishedText!;
        changed = true;
      }
      // Noted once the day's outcome is known, so it says only what the team may still have.
      const noteWaiting = () => {
        if (rendered.deferred.length > 0)
          problems.push(
            withRemoval(
              `Some of ${day}'s newest work is waiting because that day's shared memory reached its size limit.`,
            ),
          );
      };
      const privacyCleanup = rendered.freshThreads.size === 0 && owesWithdrawal;
      const sha = rendered.text === null ? null : sha256(rendered.text);
      if (sha === record.publishedSha) {
        // The team's file already leaves them out.
        const settled = settleRemovals();
        if (rendered.text === null) delete team.days[day];
        if (changed || settled || rendered.text === null) yield* writeState(state);
        noteWaiting();
        continue;
      }
      if (!(yield* teamsEnabled) && !privacyCleanup) continue;
      // Each thread is asked about again right before each request that changes the file:
      // still not withdrawn, and, for new text, still in the same project, shared the same way,
      // with Memory still on.
      const included = [...rendered.included.keys()];
      let changedSharing = false;
      const stillShared = Effect.gen(function* () {
        const now = yield* provide(threadsNow(included));
        changedSharing =
          included.some((threadId) => {
            const current = now.get(threadId);
            const section = record.sections[threadId];
            return (
              current !== undefined &&
              section !== undefined &&
              (current.off || current.resumedAt !== (section.sharing ?? null))
            );
          }) ||
          [...rendered.freshThreads].some(
            ([threadId, then]) => !sameThread(now.get(threadId), then),
          ) ||
          (rendered.freshThreads.size > 0 && !(yield* sharingEnabled)) ||
          (!privacyCleanup && !(yield* teamsEnabled));
        return !changedSharing;
      }).pipe(Effect.orElseSucceed(() => false));
      if (!(yield* stillShared)) return "retry" as const;
      // Recorded before the write, so a crash can neither hide the marker's month nor lose
      // track of a file that may now exist, or of the folder it would be in.
      if ((record.storageKey ?? null) === null) {
        if (workspace.storageKey === null) {
          noteWaiting();
          problems.push(
            withRemoval(`Harness couldn't confirm the team's folder, so ${day} waits.`),
          );
          continue;
        }
        record.storageKey = workspace.storageKey;
      }
      yield* advanceMonth(team, day);
      record.attempt = {
        sha,
        conditional: true,
        included: Object.fromEntries(rendered.included),
        generations: Object.fromEntries(
          [...rendered.included.keys()].map((threadId) => [
            threadId,
            record.sections[threadId]?.sharing ?? null,
          ]),
        ),
      };
      yield* writeState(state);
      const result = yield* attached.write({
        teamId: workspace.teamId,
        author: state.author,
        path: teamDailyPath(state.author, day, state.deviceId),
        text: rendered.text,
        etag: record.etag,
        storageKey: record.storageKey ?? null,
        freshProjects: [...rendered.freshProjects].map(([projectId, sharingSince]) => ({
          projectId,
          sharingSince,
        })),
        stillShared,
        ...(privacyCleanup ? { privacyCleanup: true as const } : {}),
      });
      if (result.kind === "lost") return "lost" as const;
      if (result.kind === "held") {
        if (!result.uncertain) {
          delete record.attempt;
          if (record.publishedSha === null) record.storageKey = null;
          yield* writeState(state);
        }
        if (changedSharing) return "retry" as const;
        // Uncertain content requests stay recorded until their remote outcome is known.
        // Other days and the marker still progress; definite no-send failures can retry.
        noteWaiting();
        problems.push(withRemoval(`${day}: ${result.message}`));
        continue;
      }
      if (result.kind === "changed") {
        // Nothing was sent, but inspect the conflicting file before adopting a new version.
        record.attempt.confirmedUnsent = true;
        yield* writeState(state);
        noteWaiting();
        problems.push(withRemoval(`${day}: ${result.message}`));
        continue;
      }
      if (result.kind === "rejected") {
        // Nothing was sent. A day the team has nothing of yet is bound again on a later try.
        delete record.attempt;
        if (record.publishedSha === null) record.storageKey = null;
        yield* writeState(state);
        noteWaiting();
        problems.push(withRemoval(`${day}: ${result.message}`));
        continue;
      }
      delete record.attempt;
      cleanedUp ||= privacyCleanup;
      yield* advanceMonth(team, day);
      settleRemovals();
      if (rendered.text === null) {
        delete team.days[day];
      } else {
        for (const [threadId, text] of rendered.included) {
          const section = record.sections[threadId];
          if (section) section.publishedText = text;
        }
        record.etag = result.etag;
        record.publishedSha = sha;
        record.storageKey = result.storageKey;
      }
      yield* writeState(state);
      yield* setStatus(workspace.teamId, { lastPublishedAt: yield* nowIso });
      noteWaiting();
    }
    const marker = yield* publishMarker(attached, state, team, workspace, cleanedUp);
    if (marker === "held" && problems.length > 0)
      // A day's problem, such as text the team may still have, says more than the marker's.
      yield* setStatus(workspace.teamId, { state: "held", message: problems[0]! });
    if (marker !== "done") return marker;
    if (problems.length > 0) {
      yield* setStatus(workspace.teamId, { state: "held", message: problems[0]! });
      return "partial" as const;
    }
    return "done" as const;
  });

  const memoryOff = {
    state: "held",
    message: "Memory is off, so your work isn't summarized for the team.",
  } as const;

  const paused = {
    state: "held",
    message: "Experimental Teams is off, so background sharing is paused.",
  } as const;
  const pausedStatus = input.settings.getSettings.pipe(
    Effect.map((settings) => (settings.experimentalTeamsEnabled ? memoryOff : paused)),
  );

  const pass = Effect.gen(function* () {
    const attached = yield* Ref.get(source);
    if (!attached) return;
    const stored = yield* readState;
    if (!(yield* teamsEnabled)) {
      if (Option.isNone(stored)) return;
      const records = Object.values(stored.value.teams).flatMap((team) => Object.values(team.days));
      const threads = yield* provide(
        threadsNow([...new Set(records.flatMap((day) => Object.keys(day.sections)))]),
      );
      for (const teamId of Object.keys(stored.value.teams)) yield* setStatus(teamId, paused);
      const owed = records.some((day) =>
        Object.entries(day.sections).some(([threadId, section]) => {
          const current = threads.get(threadId);
          return (
            section.owesRemoval === true ||
            (current !== undefined &&
              (current.off || current.resumedAt !== (section.sharing ?? null)) &&
              (section.publishedText !== null || day.attempt?.included[threadId] !== undefined))
          );
        }),
      );
      if (!owed) return;
    }
    const account = yield* attached.account(
      Option.isSome(stored) ? Object.keys(stored.value.teams) : [],
    );
    if (account.kind === "unavailable") {
      for (const teamId of statuses.keys())
        yield* setStatus(teamId, { state: "held", message: account.message });
      return;
    }
    if (account.kind === "signed-out") {
      // Nothing is shared without an account; files already published stay with their teams.
      // The record stays, unused, so the same account can still withdraw them after signing in.
      statuses.clear();
      return;
    }
    let state: State;
    if (Option.isSome(stored) && stored.value.author === account.author) state = stored.value;
    else {
      // Another account never uses this record: it is set aside for its own account, and this
      // account's own record, if it set one aside earlier, comes back.
      if (Option.isSome(stored))
        yield* writeStateAt(setAsideFile(stored.value.author), stored.value);
      statuses.clear();
      const restored = yield* readStateAt(setAsideFile(account.author));
      state =
        Option.isSome(restored) && restored.value.author === account.author
          ? restored.value
          : {
              version: 1,
              author: account.author,
              deviceId: NodeCrypto.randomUUID(),
              teams: {},
            };
      yield* writeState(state);
      yield* fs.remove(setAsideFile(account.author)).pipe(Effect.ignore);
    }
    const nowMs = yield* Clock.currentTimeMillis;
    for (const workspace of account.workspaces) {
      const teamId = workspace.teamId;
      if (workspace.access === "lost") {
        delete state.teams[teamId];
        statuses.delete(teamId);
        continue;
      }
      if (workspace.access === "held") {
        yield* setStatus(teamId, {
          state: "held",
          message: workspace.message ?? "Team access couldn't be checked. Harness will try again.",
        });
        continue;
      }
      const team: Team = state.teams[teamId] ?? {
        teamName: workspace.teamName,
        lastFinishedDay: null,
        days: {},
      };
      team.teamName = workspace.teamName;
      state.teams[teamId] = team;
      // Whether this pass left the team's newest work unsummarized.
      const enabled = yield* sharingEnabled;
      let held = !enabled;
      if (!enabled) {
        yield* setStatus(teamId, yield* pausedStatus);
      } else {
        const summarized = yield* summarizeTeam(
          attached,
          state,
          team,
          workspace,
          account.authorName,
          nowMs,
        ).pipe(
          Effect.catchTags({
            TextGenerationError: (error) => {
              held = true;
              return setStatus(teamId, { state: "held", message: error.detail }).pipe(
                Effect.as(true),
              );
            },
          }),
        );
        if (!summarized) continue;
      }
      let outcome = yield* publishTeam(attached, state, team, workspace);
      // A thread chosen as Don't share, or Memory turned off, mid-pass: render again.
      if (outcome === "retry") outcome = yield* publishTeam(attached, state, team, workspace);
      if (outcome === "lost") {
        delete state.teams[teamId];
        statuses.delete(teamId);
      } else if (outcome === "done" && !held) {
        // Memory may have been turned off while this pass ran.
        yield* setStatus(
          teamId,
          (yield* sharingEnabled) ? { state: "sharing", message: null } : yield* pausedStatus,
        );
      }
    }
    yield* writeState(state);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("team memory pass failed", { cause: Cause.pretty(cause) }),
    ),
  );

  return {
    attach: (next: TeamDailySource) => Ref.set(source, next),
    /** One pass, after any pass in progress. */
    run: lock.withPermits(1)(pass),
    status: (teamId: string) => Effect.sync(() => statuses.get(teamId) ?? null),
  };
});
