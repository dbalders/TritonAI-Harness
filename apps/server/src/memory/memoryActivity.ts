/**
 * The thread activity memory summarizes, read from the orchestration projections.
 *
 * Personal daily memory reads every project's activity for a day. Team daily memory passes a
 * `TeamActivityScope`, which narrows the query itself to the team's linked projects, to work after
 * each project's sharing began, and to threads not chosen as Don't share, so nothing else is read.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type MemoryActivityMessage,
  type MemoryThreadActivity,
  selectMemoryMessages,
} from "./memoryNotes.ts";

interface ActivityRow {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly threadTitle: string;
  readonly branch: string | null;
  readonly linkedPullRequest: string | null;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly codexThreadId: string | null;
  readonly sharingResumedAt: string | null;
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

/**
 * Limits activity to a team's linked projects: only messages from each project after its sharing
 * began, from threads not chosen as Don't share. Other projects are never read.
 */
export interface TeamActivityScope {
  /** Project id to the ISO time its link began sharing. */
  readonly projects: ReadonlyMap<string, string>;
}

/**
 * What makes a message team work, for messages `m` in threads `t` of projects `p`: the thread and
 * project still exist, the thread is shared, the message is after its last Share this thread, and
 * the project is linked, with the message after its link began sharing. Reading activity and
 * waiting for streaming turns both use it, so excluded work never holds back included work.
 */
const teamScopeCondition = (sql: SqlClient.SqlClient, scope: TeamActivityScope) =>
  sql`AND t.deleted_at IS NULL
    AND p.deleted_at IS NULL
    AND t.team_sharing_off_at IS NULL
    AND (t.team_sharing_resumed_at IS NULL OR m.created_at >= t.team_sharing_resumed_at)
    AND ${sql.or(
      [...scope.projects].map(
        ([projectId, since]) => sql`(p.project_id = ${projectId} AND m.created_at >= ${since})`,
      ),
    )}`;

/** When a thread's activity in the range began and ended, and a key that changes with it. */
export interface ActivityExtent {
  readonly firstAt: string;
  readonly lastAt: string;
  readonly fingerprint: string;
  /** When the thread was last shared again after Don't share, or null if it never was. */
  readonly sharingResumedAt: string | null;
}

/**
 * Threads with messages in `[startIso, endIso)`, in order of first activity. With `scope`, only
 * that team work is read (see `TeamActivityScope`).
 */
export const loadDayActivity = Effect.fn("memory.loadDayActivity")(function* (
  range: {
    readonly startIso: string;
    readonly endIso: string;
  },
  scope?: TeamActivityScope,
) {
  if (scope && scope.projects.size === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ActivityRow>`
    SELECT
      m.thread_id AS "threadId",
      m.turn_id AS "turnId",
      m.role,
      m.text,
      m.created_at AS "createdAt",
      m.updated_at AS "updatedAt",
      t.team_sharing_resumed_at AS "sharingResumedAt",
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
      ${scope ? teamScopeCondition(sql, scope) : sql``}
    ORDER BY m.created_at ASC, m.message_id ASC
  `;

  const threads = new Map<
    string,
    {
      activity: MemoryThreadActivity;
      messages: MemoryActivityMessage[];
      firstAt: string;
      lastAt: string;
      count: number;
      latest: string;
      sharingResumedAt: string | null;
    }
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
        firstAt: row.createdAt,
        lastAt: row.createdAt,
        count: 0,
        latest: "",
        sharingResumedAt: row.sharingResumedAt,
      };
      threads.set(row.threadId, entry);
    }
    entry.lastAt = row.createdAt;
    entry.count++;
    if (row.updatedAt > entry.latest) entry.latest = row.updatedAt;
    if (row.text.trim().length === 0) continue;
    entry.messages.push({
      turnId: row.turnId,
      role: row.role === "user" ? "user" : "assistant",
      text: row.text,
      createdAt: row.createdAt,
    });
  }
  return [...threads.values()]
    .map((entry): MemoryThreadActivity & ActivityExtent => ({
      ...entry.activity,
      messages: selectMemoryMessages(entry.messages),
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
      fingerprint: `${entry.count}:${entry.latest}:${entry.activity.title}`,
      sharingResumedAt: entry.sharingResumedAt,
    }))
    .filter((thread) => thread.messages.length > 0);
});

/**
 * Whether a message from the range is still being written and was updated since `sinceIso`.
 * With `scope`, only the team's linked projects are checked.
 */
export const hasStreamingMessages = Effect.fn("memory.hasStreamingMessages")(function* (
  range: { readonly startIso: string; readonly endIso: string },
  sinceIso: string,
  scope?: TeamActivityScope,
) {
  if (scope && scope.projects.size === 0) return false;
  const sql = yield* SqlClient.SqlClient;
  const [row] = scope
    ? // Only a turn whose work the team pass could read holds it back.
      yield* sql<{ readonly streaming: number }>`
        SELECT EXISTS (
          SELECT 1 FROM projection_thread_messages AS m
          JOIN projection_threads AS t ON t.thread_id = m.thread_id
          JOIN projection_projects AS p ON p.project_id = t.project_id
          WHERE m.created_at >= ${range.startIso}
            AND m.created_at < ${range.endIso}
            AND m.is_streaming = 1
            AND m.updated_at >= ${sinceIso}
            AND m.role IN ('user', 'assistant')
            ${teamScopeCondition(sql, scope)}
        ) AS "streaming"
      `
    : yield* sql<{ readonly streaming: number }>`
        SELECT EXISTS (
          SELECT 1 FROM projection_thread_messages AS m
          WHERE m.created_at >= ${range.startIso}
            AND m.created_at < ${range.endIso}
            AND m.is_streaming = 1
            AND m.updated_at >= ${sinceIso}
        ) AS "streaming"
      `;
  return Boolean(row?.streaming);
});
