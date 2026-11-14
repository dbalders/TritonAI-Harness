import * as Multipart from "effect/http/Multipart";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentOrchestrationAttachmentUpload,
  ThreadId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { seedV2Activity } from "../persistence/HarnessActivity.testkit.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { makeLegacyAttachmentUploads } from "./LegacyAttachmentUploads.ts";

let threadSequence = 0;
const layer = Layer.mergeAll(
  Sqlite.layerMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "harness-legacy-uploads-" }),
  Layer.mock(ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));
const fixture = Effect.gen(function* () {
  const threadId = ThreadId.make(`legacy-upload-thread-${++threadSequence}`);
  let uploadSequence = 0;
  const uploadIds = new Map<string, string>();
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const source = `${config.baseDir}/source.txt`;
  yield* fs.writeFileString(source, "upload");
  const uploads = yield* makeLegacyAttachmentUploads;
  const payload = (key: string) => {
    const uploadId =
      uploadIds.get(key) ?? `00000000-0000-4000-8000-${String(++uploadSequence).padStart(12, "0")}`;
    uploadIds.set(key, uploadId);
    return compiledDecodeSync1({
      uploadId,
      file: [
        compiledDecodeSync2({
          key: "file",
          name: "report.txt",
          contentType: "text/plain",
          path: source,
        }),
      ],
    });
  };
  return { threadId, fs, config, source, uploads, payload };
});

it.layer(layer)("legacy multipart attachments after V2 cutover", (it) => {
  it.effect("preserves referenced V2 bytes on retry and refuses deletion", () =>
    Effect.gen(function* () {
      const { threadId, fs, source, uploads, payload, config } = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const attachment = yield* uploads.upload({
        params: { threadId },
        payload: payload("committed-upload"),
      });
      yield* seedV2Activity({
        threadId,
        projectId: "upload-project",
        title: "Uploaded",
        at: "2026-10-01",
        messages: [{ id: "uploaded-message", role: "user", text: "attached" }],
      });
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json,'$.attachments',json(${JSON.stringify([attachment])})) WHERE message_id = 'uploaded-message'`;
      yield* fs.writeFileString(source, "replacement");
      assert.deepStrictEqual(
        yield* uploads.upload({ params: { threadId }, payload: payload("committed-upload") }),
        attachment,
      );
      assert.equal(
        yield* fs.readFileString(
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
        ),
        "upload",
      );
      assert.equal(
        (yield* uploads
          .delete({ params: { threadId, attachmentId: attachment.id } })
          .pipe(Effect.flip))._tag,
        "EnvironmentRequestInvalidError",
      );
    }),
  );

  it.effect(
    "deletes owned pending uploads idempotently and refuses foreign thread identifiers",
    () =>
      Effect.gen(function* () {
        const { threadId, uploads, payload } = yield* fixture;
        const attachment = yield* uploads.upload({
          params: { threadId },
          payload: payload("pending-upload"),
        });
        assert.equal(
          (yield* uploads
            .delete({ params: { threadId: ThreadId.make("foreign"), attachmentId: attachment.id } })
            .pipe(Effect.flip))._tag,
          "EnvironmentRequestInvalidError",
        );
        assert.isTrue(
          (yield* uploads.delete({ params: { threadId, attachmentId: attachment.id } })).deleted,
        );
        assert.isFalse(
          (yield* uploads.delete({ params: { threadId, attachmentId: attachment.id } })).deleted,
        );
      }),
  );

  it.effect("does not let retained V1 rows resurrect an authoritative V2 tombstone", () =>
    Effect.gen(function* () {
      const { threadId, uploads, payload } = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const attachment = yield* uploads.upload({
        params: { threadId },
        payload: payload("deleted-upload"),
      });
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('upload-project','Upload','/tmp/upload','[]','2026-10-01','2026-10-01')`;
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,created_at,updated_at) VALUES (${threadId},'upload-project','Upload','2026-10-01','2026-10-01')`;
      yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,attachments_json,is_streaming,created_at,updated_at) VALUES ('old-upload-message',${threadId},'user','old',${JSON.stringify([attachment])},0,'2026-10-01','2026-10-01')`;
      yield* seedV2Activity({
        threadId,
        projectId: "upload-project",
        title: "Deleted",
        at: "2026-10-01",
        deletedAt: "2026-10-02",
        messages: [{ id: "old-upload-message", role: "user", text: "old" }],
      });
      assert.isTrue(
        (yield* uploads.delete({ params: { threadId, attachmentId: attachment.id } })).deleted,
      );
    }),
  );

  it.effect(
    "enforces pending capacity and reclaims expired pending bytes before accepting an upload",
    () =>
      Effect.gen(function* () {
        const { threadId, fs, config, uploads, payload } = yield* fixture;
        const attachment = yield* uploads.upload({
          params: { threadId },
          payload: payload("capacity-upload"),
        });
        const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!;
        yield* fs.truncate(path, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
        assert.equal(
          (yield* uploads
            .upload({ params: { threadId }, payload: payload("over-capacity") })
            .pipe(Effect.flip))._tag,
          "EnvironmentRequestInvalidError",
        );
        yield* fs.utimes(path, 0, 0);
        yield* TestClock.adjust("2 hours");
        yield* uploads.upload({ params: { threadId }, payload: payload("after-expiry") });
        assert.isFalse(yield* fs.exists(path));
      }),
  );
});

const compiledDecodeSync1 = Schema.decodeSync(EnvironmentOrchestrationAttachmentUpload);
const compiledDecodeSync2 = Schema.decodeSync(Schema.toCodecJson(Multipart.PersistedFileSchema));
