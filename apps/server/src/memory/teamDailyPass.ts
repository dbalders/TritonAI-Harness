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
 * team. Access that couldn't be checked holds everything for a later pass.
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
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

/** Threads among `threadIds` chosen as Don't share now. */
const optedOutThreads = Effect.fn("teamMemory.optedOutThreads")(function* (
  threadIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const optedOut = new Set<string>();
  for (let index = 0; index < threadIds.length; index += 500) {
    const rows = yield* sql<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM projection_threads
      WHERE team_sharing_off_at IS NOT NULL
        AND ${sql.in("thread_id", threadIds.slice(index, index + 500))}
    `;
    for (const row of rows) optedOut.add(row.threadId);
  }
  return optedOut;
});

const scopeOf = (workspace: TeamDailyWorkspace): TeamActivityScope => ({
  projects: new Map(workspace.projects.map((p) => [p.projectId, p.sharingSince])),
});

export const makeTeamDailyPass = (input: {
  readonly stateDir: string;
  readonly deviceLabel: string;
  readonly settings: ServerSettingsService["Service"];
  readonly textGeneration: TextGeneration["Service"];
  /** Same rhythm as personal memory. */
  readonly maxCatchUpDays: number;
  readonly partialIntervalMs: number;
  readonly streamingGraceMs: number;
}) =>
  Effect.gen(function* () {
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

    const readState = fs.readFileString(stateFile).pipe(
      Effect.flatMap(decodeState),
      Effect.map((state) => Option.some(structuredClone(state) as State)),
      // A missing or unreadable record starts over: a fresh record publishes nothing old.
      Effect.orElseSucceed(() => Option.none<State>()),
    );
    const writeState = (state: State) =>
      encodeState(state).pipe(
        Effect.flatMap((contents) =>
          fs
            .makeDirectory(directory, { recursive: true })
            .pipe(Effect.andThen(writeFileStringAtomically({ filePath: stateFile, contents }))),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
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
    const summarize = (day: string, teamName: string, threads: ReadonlyArray<Activity>) =>
      Effect.gen(function* () {
        const generate = input.textGeneration.generateTeamDailyMemory;
        if (!generate)
          return yield* new TextGenerationError({
            operation: "generateTeamDailyMemory",
            detail: "Team memory needs a Codex text generation model.",
          });
        const settings = yield* input.settings.getSettings;
        const sections = new Map<string, string>();
        for (let index = 0; index < threads.length; index += THREADS_PER_CALL) {
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
    const summarizeTeam = (
      attached: TeamDailySource,
      state: State,
      team: Team,
      workspace: TeamDailyWorkspace,
      authorName: string,
      nowMs: number,
    ) =>
      Effect.gen(function* () {
        const scope = scopeOf(workspace);
        if (scope.projects.size === 0) return true;
        const today = localDayAt(nowMs);
        const earliest = addLocalDays(today, -input.maxCatchUpDays);
        const firstShared = localDayAt(Date.parse([...scope.projects.values()].toSorted()[0]!));
        const streamingSince = DateTime.formatIso(
          DateTime.makeUnsafe(nowMs - input.streamingGraceMs),
        );
        const days: Array<{ day: string; status: "partial" | "final" }> = [];
        let day = team.lastFinishedDay ? addLocalDays(team.lastFinishedDay, 1) : earliest;
        for (const floor of [earliest, firstShared]) if (day < floor) day = floor;
        for (; day < today; day = addLocalDays(day, 1)) days.push({ day, status: "final" });
        const todayRecord = team.days[today];
        if (!todayRecord || nowMs - Date.parse(todayRecord.summarizedAt) >= input.partialIntervalMs)
          days.push({ day: today, status: "partial" });

        for (const entry of days) {
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
            // Anything that stopped qualifying while the model ran is dropped, not recorded.
            const after = yield* attached.account([workspace.teamId]);
            const fresh = workspaceOf(after, workspace.teamId);
            if (after.kind !== "signed-in" || after.author !== state.author || !fresh) return false;
            if (fresh.access !== "ready") return false;
            const stillLinked = scopeOf(fresh).projects;
            const optedOut = yield* provide(optedOutThreads(changed.map((t) => t.threadId)));
            for (const thread of changed) {
              const text = summaries.get(thread.threadId);
              const linkSince = scope.projects.get(thread.projectId)!;
              if (
                text === undefined ||
                optedOut.has(thread.threadId) ||
                stillLinked.get(thread.projectId) !== linkSince
              )
                continue;
              record.sections[thread.threadId] = {
                projectId: thread.projectId,
                linkSince,
                text,
                publishedText: record.sections[thread.threadId]?.publishedText ?? null,
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

    /** Publishes the team's change marker when it says something new. */
    const publishMarker = (attached: TeamDailySource, state: State, team: Team, teamId: string) =>
      Effect.gen(function* () {
        const marker = team.marker;
        if (!marker) return "done" as const;
        const text = yield* encodeMarker({
          version: 1,
          months: Object.fromEntries(Object.entries(marker.months).toSorted()),
        });
        const sha = sha256(text);
        if (sha === marker.publishedSha) return "done" as const;
        const result = yield* attached.write({
          teamId,
          author: state.author,
          path: teamDailyMarkerPath(state.author, state.deviceId),
          text,
          etag: marker.etag,
          freshProjects: [],
          stillShared: Effect.succeed(true),
        });
        if (result.kind === "lost") return "lost" as const;
        if (result.kind === "held") {
          yield* setStatus(teamId, { state: "held", message: result.message });
          return "held" as const;
        }
        marker.publishedSha = sha;
        marker.etag = result.etag;
        yield* writeState(state);
        return "done" as const;
      });

    /** Writes every day file whose content changed. */
    const publishTeam = (
      attached: TeamDailySource,
      state: State,
      team: Team,
      workspace: TeamDailyWorkspace,
      /** False while Memory is off: files may lose content but gain none. */
      allowFresh: boolean,
    ) =>
      Effect.gen(function* () {
        const linkedProjects = scopeOf(workspace).projects;
        const optedOut = yield* provide(
          optedOutThreads([
            ...new Set(Object.values(team.days).flatMap((day) => Object.keys(day.sections))),
          ]),
        );
        for (const day of Object.keys(team.days).toSorted()) {
          const record = team.days[day]!;
          const rendered = renderTeamDailyFile(
            record,
            { day, author: state.author },
            { optedOut, linkedProjects, publishedOnly: !allowFresh },
          );
          // Sharing a thread again resummarizes it; unpublished text from a project no longer
          // linked as before is never published.
          let dropped = false;
          for (const threadId of [...rendered.optedOut, ...rendered.unlinked]) {
            delete record.sections[threadId];
            dropped = true;
          }
          const sha = rendered.text === null ? null : sha256(rendered.text);
          if (sha === record.publishedSha) {
            if (rendered.text === null && record.publishedSha === null) delete team.days[day];
            if (dropped) yield* writeState(state);
            continue;
          }
          // A thread can be chosen as Don't share any time: the Teams side asks again right
          // before each request that changes the file.
          const included = [...rendered.included.keys()];
          let changedSharing = false;
          const stillShared = provide(optedOutThreads(included)).pipe(
            Effect.map((now) => {
              changedSharing = [...now].some((threadId) => !optedOut.has(threadId));
              return !changedSharing;
            }),
            Effect.orElseSucceed(() => false),
          );
          if (!(yield* stillShared)) return "retry" as const;
          // Stamped before the write, so a crash before the marker is published can't hide it.
          const marker = (team.marker ??= { months: {}, publishedSha: null, etag: null });
          marker.months[day.slice(0, 7)] = yield* nowIso;
          yield* writeState(state);
          const result = yield* attached.write({
            teamId: workspace.teamId,
            author: state.author,
            path: teamDailyPath(state.author, day, state.deviceId),
            text: rendered.text,
            etag: record.etag,
            freshProjects: [...rendered.freshProjects].map(([projectId, sharingSince]) => ({
              projectId,
              sharingSince,
            })),
            stillShared,
          });
          if (result.kind === "lost") return "lost" as const;
          if (result.kind === "held" && changedSharing) return "retry" as const;
          if (result.kind === "held") {
            yield* writeState(state);
            yield* setStatus(workspace.teamId, { state: "held", message: result.message });
            return "held" as const;
          }
          if (rendered.text === null) {
            delete team.days[day];
          } else {
            for (const [threadId, text] of rendered.included) {
              const section = record.sections[threadId];
              if (section) section.publishedText = text;
            }
            record.etag = result.etag;
            record.publishedSha = sha;
          }
          yield* writeState(state);
          yield* setStatus(workspace.teamId, { lastPublishedAt: yield* nowIso });
        }
        return yield* publishMarker(attached, state, team, workspace.teamId);
      });

    const pass = Effect.gen(function* () {
      const attached = yield* Ref.get(source);
      if (!attached) return;
      const settings = yield* input.settings.getSettings;
      const stored = yield* readState;
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
        yield* fs.remove(stateFile).pipe(Effect.ignore);
        statuses.clear();
        return;
      }
      // Another account starts with an empty record: nothing of the previous one is reused.
      const state: State =
        Option.isSome(stored) && stored.value.author === account.author
          ? stored.value
          : {
              version: 1,
              author: account.author,
              deviceId: Option.isSome(stored) ? stored.value.deviceId : NodeCrypto.randomUUID(),
              teams: {},
            };
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
            message:
              workspace.message ?? "Team access couldn't be checked. Harness will try again.",
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
        let held = !settings.memoryEnabled;
        if (!settings.memoryEnabled) {
          yield* setStatus(teamId, {
            state: "held",
            message: "Memory is off, so your work isn't summarized for the team.",
          });
        } else {
          const summarized = yield* summarizeTeam(
            attached,
            state,
            team,
            workspace,
            account.authorName,
            nowMs,
          ).pipe(
            Effect.catchTag("TextGenerationError", (error) => {
              held = true;
              return setStatus(teamId, { state: "held", message: error.detail }).pipe(
                Effect.as(true),
              );
            }),
          );
          if (!summarized) continue;
        }
        let outcome = yield* publishTeam(attached, state, team, workspace, settings.memoryEnabled);
        // A thread chosen as Don't share mid-pass: render again without it.
        if (outcome === "retry")
          outcome = yield* publishTeam(attached, state, team, workspace, settings.memoryEnabled);
        if (outcome === "lost") {
          delete state.teams[teamId];
          statuses.delete(teamId);
        } else if (outcome === "done" && !held) {
          yield* setStatus(teamId, { state: "sharing", message: null });
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
