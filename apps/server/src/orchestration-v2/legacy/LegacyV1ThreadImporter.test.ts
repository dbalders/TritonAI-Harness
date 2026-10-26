import { MessageId } from "@t3tools/contracts";
import { ProviderThreadId } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { OrchestrationV2ProviderThread } from "@t3tools/contracts";

import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";

import {
  ComposerContextId,
  EventId,
  type OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Effect from "effect/Effect";

import * as Exit from "effect/Exit";

import * as Layer from "effect/Layer";

import * as SqlClient from "effect/sql/SqlClient";

import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";

import { listLinkedPullRequestThreads } from "../../pullRequest/linkedThreads.ts";

import * as EventSink from "../EventSink.ts";

import * as EventStore from "../EventStore.ts";

import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";

import * as ProjectionStore from "../ProjectionStore.ts";

const layerDatabase = SqlitePersistence.layerMemory;

const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));

const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));

const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);

const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));

const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
);

const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStoresProvided),
);

const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerImporterProvided,
  layerProjectionMaintenanceProvided,
);

const seedPendingTranscripts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadIds = [ThreadId.make("thread:first"), ThreadId.make("thread:later")];
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'project:background', 'Legacy project', '/tmp/legacy-background', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
  for (const threadId of threadIds) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        ${threadId}, 'project:background', 'Legacy thread',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES
        (${`${threadId}:old`}, ${threadId}, 'user', 'Old question', 0,
          '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z'),
        (${`${threadId}:latest`}, ${threadId}, 'user', 'Latest question', 0,
          '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:00.000Z')
    `;
  }
  yield* importer.reconcileShells;
});

it.effect(
  "keeps hydrating later transcripts after a defect and leaves the failed thread pending",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seedPendingTranscripts;
      yield* sql`
        UPDATE projection_thread_messages SET created_at = '0000-not-a-date'
        WHERE message_id = 'thread:first:old'
      `;

      yield* importer.importPendingTranscripts;

      const later = yield* projections.getThreadProjection(ThreadId.make("thread:later"));
      assert.deepStrictEqual(
        later.messages.map((message) => message.text),
        ["Old question", "Latest question"],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT thread_id, transcript_imported_at, last_error FROM orchestration_v2_legacy_imports
          WHERE transcript_imported_at IS NULL OR last_error IS NOT NULL
        `,
        [
          {
            thread_id: "thread:first",
            transcript_imported_at: null,
            last_error: "Transcript hydration failed; retry on next open.",
          },
        ],
      );
    }).pipe(Effect.provide(layerTest)),
);

// regression: #15920 one bad legacy message stopped the server from starting
it.effect("propagates interruption from transcript reads and retry-marker writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    yield* seedPendingTranscripts;
    const interrupted = [];
    for (const phase of ["transcript", "retry-marker"]) {
      const exit = yield* importer.importPendingTranscripts.pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          const [query] = statement.compile();
          const readingTranscript = query.includes("FROM projection_thread_messages");
          const writingRetryMarker = query.includes("SET last_error =");
          if (phase === "retry-marker" && readingTranscript) {
            return Effect.die("transcript read failed");
          }
          if (phase === "transcript" ? readingTranscript : writingRetryMarker) {
            return Effect.interrupt;
          }
          return Effect.succeed(statement);
        }),
        Effect.exit,
      );
      interrupted.push(Exit.hasInterrupts(exit));
    }
    assert.deepStrictEqual(interrupted, [true, true]);
    assert.deepStrictEqual(
      yield* sql`
        SELECT thread_id FROM orchestration_v2_legacy_imports
        WHERE transcript_imported_at IS NOT NULL OR last_error IS NOT NULL
      `,
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);

// regression: #427 preserve migration activity, native file stashes and fatal shutdown
it.effect("preserves newer thread activity while hydrating legacy transcripts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:legacy-activity");
    const shellAt = "2026-01-04T00:00:00.000Z";
    const source = [
      ["message:activity:1", "user", "2026-01-01T01:00:00.000Z"],
      ["message:activity:2", "assistant", "2026-01-01T02:00:00.000Z"],
      ["message:activity:3", "user", "2026-01-02T01:00:00.000Z"],
      ["message:activity:4", "assistant", "2026-01-02T02:00:00.000Z"],
    ] as const;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (
        'project:legacy-activity', 'Legacy project', '/tmp/legacy-activity', '[]',
        '2026-01-01T00:00:00.000Z', ${shellAt}
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        ${threadId}, 'project:legacy-activity', 'Preserved shell',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'approval-required', 'plan',
        '2026-01-01T00:00:00.000Z', ${shellAt}
      )
    `;
    for (const [id, role, at] of source) {
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (${id}, ${threadId}, ${role}, ${id}, 0, ${at}, ${at})
      `;
    }
    const sourceRows = yield* sql`
      SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
    `;
    yield* importer.reconcileShells;
    const shell = yield* projections.getThread(threadId);
    assert.deepEqual(shell.updatedAt, DateTime.makeUnsafe(shellAt));
    assert.deepStrictEqual(
      (yield* projections.getThreadProjection(threadId)).messages.map((message) => message.id),
      source.slice(2).map(([id]) => MessageId.make(id)),
    );

    assert.deepStrictEqual(yield* importer.ensureTranscript(threadId), {
      importedThreadCount: 1,
      importedMessageCount: 2,
    });
    const readActivity = Effect.gen(function* () {
      const projection = yield* projections.getThreadProjection(threadId);
      const storedEvents = yield* events.read({ threadId }).pipe(Stream.runCollect);
      const memory = yield* Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        for (const stored of storedEvents) yield* store.apply(stored.event);
        return yield* store.getThreadProjection(threadId);
      }).pipe(Effect.provide(ProjectionStore.layerMemory));
      const [row] = yield* sql<{ readonly scalar: string; readonly payload: string }>`
        SELECT updated_at AS scalar, json_extract(payload_json, '$.updatedAt') AS payload
        FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      `;
      return {
        scalar: row?.scalar,
        payload: row?.payload,
        sqlThread: DateTime.formatIso(projection.thread.updatedAt),
        sqlProjection: DateTime.formatIso(projection.updatedAt),
        memoryThread: DateTime.formatIso(memory.thread.updatedAt),
        memoryProjection: DateTime.formatIso(memory.updatedAt),
      };
    });
    const expectedActivity = (at: string) => ({
      scalar: at,
      payload: at,
      sqlThread: at,
      sqlProjection: at,
      memoryThread: at,
      memoryProjection: at,
    });
    assert.deepStrictEqual(yield* readActivity, expectedActivity(shellAt));
    const hydrated = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(hydrated.thread, shell);
    assert.deepStrictEqual(
      hydrated.messages.map((message) => [
        message.id,
        DateTime.formatIso(message.createdAt),
        DateTime.formatIso(message.updatedAt),
      ]),
      source.map(([id, , at]) => [id, at, at]),
    );
    assert.deepStrictEqual(
      hydrated.turnItems.map((item) => [
        item.id,
        item.ordinal,
        item.startedAt && DateTime.formatIso(item.startedAt),
        item.completedAt && DateTime.formatIso(item.completedAt),
        DateTime.formatIso(item.updatedAt),
      ]),
      source.map(([id, , at], index) => [`migration:v1:turn-item:${id}`, index + 1, at, at, at]),
    );
    const historyEvents = yield* events.read({ threadId }).pipe(Stream.runCollect);
    for (const [id, , at] of source) {
      assert.deepStrictEqual(
        historyEvents
          .filter(({ event }) =>
            [`migration:v1:message:${id}`, `migration:v1:turn-item:${id}`].includes(event.id),
          )
          .map(({ event }) => DateTime.formatIso(event.occurredAt)),
        [at, at],
      );
    }
    assert.deepStrictEqual(yield* importer.ensureTranscript(threadId), {
      importedThreadCount: 0,
      importedMessageCount: 0,
    });
    assert.deepStrictEqual(yield* events.read({ threadId }).pipe(Stream.runCollect), historyEvents);
    assert.deepStrictEqual(yield* readActivity, expectedActivity(shellAt));
    assert.deepStrictEqual(
      yield* sql`
        SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
      `,
      sourceRows,
    );

    const liveAt = "2026-01-05T00:00:00.000Z";
    const message = hydrated.messages[0]!;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:legacy-activity:live-message"),
          type: "message.updated",
          threadId,
          occurredAt: DateTime.makeUnsafe(liveAt),
          payload: { ...message, text: "Live update", updatedAt: DateTime.makeUnsafe(liveAt) },
        },
      ],
    });
    assert.deepStrictEqual(yield* readActivity, expectedActivity(liveAt));
    assert.deepEqual(yield* projections.getThread(threadId), {
      ...shell,
      updatedAt: DateTime.makeUnsafe(liveAt),
    });
  }).pipe(Effect.provide(layerTest)),
);

it.layer(layerTest)("LegacyV1ThreadImporter", (it) => {
  it.effect("imports lightweight shells, hydrates transcripts, and remains idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-import");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          'project:legacy-import',
          'Legacy project',
          '/tmp/legacy-project',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          unsettled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          linked_pull_request_json,
          deleted_at
        ) VALUES (
          ${threadId},
          'project:legacy-import',
          'Migrated conversation',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          ' main ',
          ' /tmp/legacy-project ',
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          '2026-01-03T12:00:00.000Z',
          '2026-02-01T00:00:00.000Z',
          '2026-01-04T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-import","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        ) VALUES
          (
            'message:legacy:1',
            ${threadId},
            NULL,
            'user',
            'First question',
            '[]',
            0,
            '2026-01-01T01:00:00.000Z',
            '2026-01-01T01:00:00.000Z'
          ),
          (
            'message:legacy:2',
            ${threadId},
            NULL,
            'assistant',
            'First answer',
            '[]',
            0,
            '2026-01-02T01:00:00.000Z',
            '2026-01-02T01:00:00.000Z'
          ),
          (
            'message:legacy:3',
            ${threadId},
            NULL,
            'user',
            'Follow-up question',
            '[]',
            0,
            '2026-01-03T01:00:00.000Z',
            '2026-01-03T01:00:00.000Z'
          ),
          (
            'message:legacy:4',
            ${threadId},
            NULL,
            'assistant',
            'Partial answer',
            '[]',
            1,
            '2026-01-04T01:00:00.000Z',
            '2026-01-04T01:00:00.000Z'
        )
      `;

      const validContext = {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("ctx_1"),
            kind: "skill",
            label: "$test",
            name: "test",
          },
        ],
      } satisfies OrchestrationMessageContext;
      yield* sql`
        UPDATE projection_thread_messages
        SET context_json = CASE message_id
          WHEN 'message:legacy:2' THEN '{broken-json'
          WHEN 'message:legacy:3' THEN '{"version":2,"records":[]}'
          ELSE ${JSON.stringify(validContext)}
        END
        WHERE thread_id = ${threadId}
      `;
      const sourceMessages = yield* sql`
        SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
      `;

      yield* sql`
        INSERT INTO projection_thread_pull_requests (
          thread_id, host, repository, number, url, source, linked_at, snapshot_json
        ) VALUES
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9002,
            'https://github.com/pingdotgg/t3code/pull/9002', 'created',
            '2026-01-03T00:00:00.000Z',
            '{"state":"open","title":"Second PR","headBranch":"feature-two","baseBranch":"main","isDraft":false,"updatedAt":"2026-01-03T00:00:00.000Z","syncedAt":"2026-01-03T00:00:00.000Z"}'),
          (${threadId}, 'github.com', 'pingdotgg/t3code', 9003,
            'https://github.com/pingdotgg/t3code/pull/9003', 'manual',
            '2026-01-04T00:00:00.000Z', NULL)
      `;

      assert.equal(yield* importer.pendingThreadCount, 1);
      const shellImport = yield* importer.reconcileShells;
      assert.equal(yield* importer.pendingThreadCount, 1);
      assert.deepStrictEqual(shellImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const shellEventCount = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(shellEventCount[0]?.count, 6);

      assert.isTrue((yield* maintenance.verify).valid);
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.equal(shellProjection.thread.historyOrigin, "v1_import");
      assert.equal(shellProjection.thread.branch, "main");
      assert.equal(shellProjection.thread.worktreePath, "/tmp/legacy-project");
      assert.deepEqual(
        shellProjection.thread.pinnedAt,
        DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.pinOrderKey, "m");
      assert.deepEqual(
        shellProjection.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        shellProjection.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(shellProjection.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(shellProjection.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      assert.deepStrictEqual(
        (yield* listLinkedPullRequestThreads({
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 9002,
        })).threads.map((thread) => thread.id),
        [threadId],
      );
      const shellSnapshot = yield* projections.getShellSnapshot();
      assert.equal(
        shellSnapshot.threads.find((thread) => thread.id === threadId)?.historyOrigin,
        "v1_import",
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => message.id),
        ["message:legacy:3", "message:legacy:4"],
      );
      assert.deepStrictEqual(
        shellProjection.messages.map((message) => [message.text, message.context]),
        [
          ["Follow-up question", undefined],
          ["Partial answer", validContext],
        ],
      );

      const renamedAt = DateTime.makeUnsafe("2026-01-05T00:00:00.000Z");
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:metadata-after-shell"),
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: shellProjection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: {
              ...shellProjection.thread,
              title: "Renamed after shell import",
              runtimeMode: "approval-required",
              interactionMode: "plan",
              archivedAt: renamedAt,
              settledOverride: "settled",
              settledAt: renamedAt,
              updatedAt: renamedAt,
            },
          },
        ],
      });

      const transcriptImport = yield* importer.importPendingTranscripts;
      assert.equal(yield* importer.pendingThreadCount, 0);
      assert.deepStrictEqual(transcriptImport, {
        importedThreadCount: 1,
        importedMessageCount: 2,
      });
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.thread.title, "Renamed after shell import");
      assert.isNull(projection.thread.lastVisitedAt);
      assert.equal(projection.thread.runtimeMode, "approval-required");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.deepEqual(projection.thread.archivedAt, renamedAt);
      assert.equal(projection.thread.settledOverride, "settled");
      assert.deepEqual(projection.thread.settledAt, renamedAt);
      assert.deepStrictEqual(
        projection.messages.map((message) => message.id),
        ["message:legacy:1", "message:legacy:2", "message:legacy:3", "message:legacy:4"],
      );
      const expectedMessages = [
        ["First question", validContext],
        ["First answer", undefined],
        ["Follow-up question", undefined],
        ["Partial answer", validContext],
      ];
      assert.deepStrictEqual(
        projection.messages.map((message) => [message.text, message.context]),
        expectedMessages,
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT * FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY message_id
        `,
        sourceMessages,
      );
      assert.deepStrictEqual(
        projection.turnItems
          .filter(
            (
              item,
            ): item is Extract<
              (typeof projection.turnItems)[number],
              { readonly type: "user_message" | "assistant_message" }
            > => item.type === "user_message" || item.type === "assistant_message",
          )
          .map((item) => [item.messageId, item.ordinal, item.status]),
        [
          ["message:legacy:1", 1, "completed"],
          ["message:legacy:2", 2, "completed"],
          ["message:legacy:3", 3, "completed"],
          ["message:legacy:4", 4, "interrupted"],
        ],
      );

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:legacy-import:explicit-unpin"),
            type: "thread.unpinned",
            threadId,
            providerInstanceId: projection.thread.providerInstanceId,
            occurredAt: renamedAt,
            payload: { ...projection.thread, pinnedAt: null, pinOrderKey: null },
          },
        ],
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(
          payload_json,
          '$.snoozedUntil',
          '$.snoozedAt',
          '$.unsettledAt',
          '$.linkedPullRequest',
          '$.pullRequests'
        )
        WHERE thread_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.deepEqual(
        repaired.thread.snoozedUntil,
        DateTime.makeUnsafe("2026-02-01T00:00:00.000Z"),
      );
      assert.deepEqual(
        repaired.thread.unsettledAt,
        DateTime.makeUnsafe("2026-01-03T12:00:00.000Z"),
      );
      assert.equal(repaired.thread.linkedPullRequest?.number, 9000);
      assert.deepStrictEqual(
        (repaired.thread.pullRequests ?? []).map((link) => link.number),
        [9002, 9003, 9000],
      );
      assert.equal(repaired.thread.pullRequests?.[0]?.snapshot?.title, "Second PR");
      const eventCountBeforeRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      assert.deepStrictEqual(yield* importer.ensureTranscript(threadId), {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });
      const eventCountAfterRetry = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${threadId}
      `;
      assert.equal(eventCountAfterRetry[0]?.count, eventCountBeforeRetry[0]?.count);
    }),
  );

  it.effect("repairs newly added metadata after an earlier metadata repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:legacy-metadata-upgrade");
      const previousRepairId = EventId.make(`migration:v1:thread:${threadId}:metadata-repair`);

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project:legacy-metadata-upgrade',
          'Legacy project',
          '/tmp/legacy-metadata-upgrade',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, pinned_at, pin_order_key,
          linked_pull_request_json, branch_pull_request_json, active_order_key
        ) VALUES (
          ${threadId},
          'project:legacy-metadata-upgrade',
          'Original v1 title',
          '{"instanceId":"codex","model":"gpt-5.4"}',
          'full-access',
          'default',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          '2026-01-02T00:00:00.000Z',
          'm',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9000,"url":"https://github.com/pingdotgg/t3code/pull/9000"}',
          '{"projectId":"project:legacy-metadata-upgrade","repository":"pingdotgg/t3code","number":9001,"url":"https://github.com/pingdotgg/t3code/pull/9001"}',
          'az'
        )
      `;
      yield* importer.reconcileShells;
      yield* maintenance.rebuild;
      const shellProjection = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(
        (shellProjection.thread.pullRequests ?? []).map((link) => link.number),
        [9000],
      );
      const previousRepairThread = {
        ...shellProjection.thread,
        title: "Renamed in v2",
        pinnedAt: null,
        pinOrderKey: null,
        linkedPullRequest: null,
        pullRequests: [],
      };
      delete previousRepairThread.branchPullRequest;
      delete previousRepairThread.activeOrderKey;
      yield* eventSink.write({
        events: [
          {
            id: previousRepairId,
            type: "thread.metadata-updated",
            threadId,
            providerInstanceId: previousRepairThread.providerInstanceId,
            occurredAt: DateTime.makeUnsafe("2026-01-03T00:00:00.000Z"),
            payload: previousRepairThread,
          },
        ],
      });

      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 1,
        importedMessageCount: 0,
      });
      const repaired = yield* projections.getThreadProjection(threadId);
      assert.equal(repaired.thread.title, "Renamed in v2");
      assert.isNull(repaired.thread.pinnedAt);
      assert.isNull(repaired.thread.pinOrderKey);
      assert.isNull(repaired.thread.linkedPullRequest);
      assert.deepStrictEqual(repaired.thread.pullRequests, []);
      assert.equal(repaired.thread.branchPullRequest?.number, 9001);
      assert.equal(repaired.thread.activeOrderKey, "az");

      const eventsBeforeRetry = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.equal(eventsBeforeRetry.length, 4);
      assert.isTrue(eventsBeforeRetry.some((event) => event.event_id === previousRepairId));
      assert.deepStrictEqual(yield* importer.reconcileShells, {
        importedThreadCount: 0,
        importedMessageCount: 0,
      });

      assert.isTrue((yield* maintenance.rebuild).valid);
      const replayed = yield* projections.getThreadProjection(threadId);
      assert.deepStrictEqual(replayed.thread, repaired.thread);
      assert.deepStrictEqual(
        yield* Effect.gen(function* () {
          const restartedImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          return yield* restartedImporter.reconcileShells;
        }).pipe(Effect.provide(LegacyV1ThreadImporter.layer)),
        { importedThreadCount: 0, importedMessageCount: 0 },
      );
      const eventsAfterRestart = yield* sql<{ readonly event_id: string }>`
        SELECT event_id
        FROM orchestration_events
        WHERE application_event_version = 2 AND stream_id = ${threadId}
        ORDER BY sequence
      `;
      assert.deepStrictEqual(eventsAfterRestart, eventsBeforeRetry);
    }),
  );
});

it.layer(layerTest)("Harness V1 goal continuity", (it) => {
  it.effect(
    "retains objectives and usage as paused imports without launching or replaying work",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const at = "2026-10-01T00:00:00.000Z";
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('goal-project','Goals','/tmp/goal-project','[]',${at},${at})`;
        const goal = JSON.stringify({
          objective: "Keep my downstream objective",
          status: "active",
          tokenBudget: 1000,
          tokensUsed: 42,
          timeUsedSeconds: 61,
        });
        yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,goal_json,created_at,updated_at) VALUES ('goal-import','goal-project','Goal thread',${goal},${at},${at})`;
        yield* importer.reconcileShells;
        const threadId = ThreadId.make("goal-import");
        const projection = yield* projections.getThreadProjection(threadId);
        assert.deepStrictEqual(projection.thread.legacyGoal, {
          origin: "legacy_v1",
          objective: "Keep my downstream objective",
          status: "paused",
          tokenBudget: 1000,
          tokensUsed: 42,
          timeUsedSeconds: 61,
        });
        assert.isNull(projection.thread.activeProviderThreadId);
        assert.lengthOf(projection.providerThreads, 0);
        assert.lengthOf(projection.runs, 0);
        const shell = (yield* projections.getShellSnapshot()).threads.find(
          (thread) => thread.id === threadId,
        );
        assert.deepStrictEqual(shell?.goal, projection.thread.legacyGoal);
        assert.deepStrictEqual(yield* importer.reconcileShells, {
          importedThreadCount: 0,
          importedMessageCount: 0,
        });
        yield* importer.ensureTranscript(threadId);
        yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
        assert.deepStrictEqual(
          (yield* projections.getThreadProjection(threadId)).thread.legacyGoal,
          projection.thread.legacyGoal,
        );
        const eventSink = yield* EventSink.EventSinkV2;
        const occurredAt = DateTime.makeUnsafe(at);
        const nativeOwner = yield* Schema.decodeUnknownEffect(OrchestrationV2ProviderThread)({
          id: ProviderThreadId.make("provider-thread:goal-import"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: projection.thread.providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: { driver: "codex", nativeId: "native:goal-import", strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          goal: null,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
        let updateNumber = 0;
        const updateOwner = (owner: OrchestrationV2ProviderThread) =>
          eventSink.write({
            events: [
              {
                id: EventId.make(`event:goal-import:${++updateNumber}`),
                type: "provider-thread.updated",
                threadId,
                occurredAt,
                payload: owner,
              },
            ],
          });
        // An ordinary reply binds native history without consuming the imported objective.
        yield* updateOwner(nativeOwner);
        assert.deepStrictEqual(
          (yield* projections.getThreadShell(threadId))?.goal,
          projection.thread.legacyGoal,
        );
        const nativeGoal = { objective: "Explicit native replacement", status: "paused" as const };
        yield* updateOwner({ ...nativeOwner, goal: nativeGoal, legacyGoalSuperseded: true });
        assert.deepStrictEqual((yield* projections.getThreadShell(threadId))?.goal, nativeGoal);
        yield* updateOwner({ ...nativeOwner, goal: null, legacyGoalSuperseded: true });
        assert.isNull((yield* projections.getThreadShell(threadId))?.goal);
        yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
        assert.isNull((yield* projections.getThreadShell(threadId))?.goal);
      }),
  );
});
