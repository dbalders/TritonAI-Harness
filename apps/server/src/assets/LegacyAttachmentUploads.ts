import {
  ChatFileAttachment,
  ChatStoredFileAttachment,
  type ThreadId,
  type EnvironmentOrchestrationAttachmentUpload,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
} from "../auth/http.ts";
import {
  createUploadAttachmentId,
  isCanonicalAttachmentIdOwnedByThread,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

const PENDING_ATTACHMENT_TTL_MS = 60 * 60 * 1000;
const MAX_GLOBAL_PENDING_ATTACHMENT_BYTES = 10 * PROVIDER_SEND_TURN_MAX_FILE_BYTES;
const isChatFileAttachment = Schema.is(ChatFileAttachment);

function isPendingAttachmentExpired(input: {
  readonly modifiedAt: number | null;
  readonly now: number;
}): boolean {
  return input.modifiedAt !== null && input.now - input.modifiedAt > PENDING_ATTACHMENT_TTL_MS;
}

function exceedsPendingAttachmentCapacity(input: {
  readonly targetPendingBytes: number;
  readonly globalPendingBytes: number;
  readonly incomingBytes: number;
}): boolean {
  return (
    input.targetPendingBytes + input.incomingBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES ||
    input.globalPendingBytes + input.incomingBytes > MAX_GLOBAL_PENDING_ATTACHMENT_BYTES
  );
}

function sanitizeAttachmentFileName(fileName: string): string {
  const sanitizedName = Array.from(fileName)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim();
  const truncated = sanitizedName.slice(0, 255);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

/** Compatibility uploads use the same canonical store as V2 pending uploads. */
export const makeLegacyAttachmentUploads = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService;
  const liveAttachmentRows = () => sql<{ id: string; attachment_json: string }>`
    SELECT DISTINCT json_extract(a.value, '$.id') AS id, a.value AS attachment_json
    FROM orchestration_v2_projection_messages m
    JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id,
      json_each(m.payload_json, '$.attachments') a
    WHERE t.deleted_at IS NULL AND json_type(a.value, '$.id') = 'text'
    UNION
    SELECT DISTINCT json_extract(a.value, '$.id') AS id, a.value AS attachment_json
    FROM projection_thread_messages m JOIN projection_threads t ON t.thread_id = m.thread_id,
      json_each(CASE WHEN json_valid(m.attachments_json) THEN m.attachments_json ELSE '[]' END) a
    WHERE t.deleted_at IS NULL AND json_type(a.value, '$.id') = 'text'
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads v2
        WHERE v2.thread_id = t.thread_id AND v2.deleted_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages v2
        WHERE v2.message_id = m.message_id)
  `;
  const attachmentUploadSemaphore = yield* Semaphore.make(1);

  const reclaimPendingAttachments = Effect.fn(
    "environment.orchestration.reclaimPendingAttachments",
  )(function* (input: {
    readonly referencedAttachmentIds: ReadonlySet<string>;
    readonly targetThreadId: string;
    readonly replacementAttachmentId: string;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const entries = yield* fileSystem.readDirectory(serverConfig.attachmentsDir).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
      }),
    );
    let globalPendingBytes = 0;
    let targetPendingBytes = 0;

    for (const entry of entries) {
      const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (
        normalizedEntry.length === 0 ||
        normalizedEntry.includes("/") ||
        normalizedEntry.startsWith(".")
      ) {
        continue;
      }
      const attachmentId = path.basename(normalizedEntry, path.extname(normalizedEntry));
      if (
        !attachmentId ||
        input.referencedAttachmentIds.has(attachmentId) ||
        attachmentId === input.replacementAttachmentId
      ) {
        continue;
      }
      const attachmentPath = path.join(serverConfig.attachmentsDir, normalizedEntry);
      const info = yield* fileSystem.stat(attachmentPath).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      const modifiedAt = Option.map(info.value.mtime, (value) => value.getTime());
      if (
        isPendingAttachmentExpired({
          modifiedAt: Option.getOrNull(modifiedAt),
          now,
        })
      ) {
        yield* fileSystem.remove(attachmentPath, { force: true });
        continue;
      }
      const sizeBytes = Number(info.value.size);
      globalPendingBytes += sizeBytes;
      if (isCanonicalAttachmentIdOwnedByThread(attachmentId, input.targetThreadId)) {
        targetPendingBytes += sizeBytes;
      }
    }

    return { globalPendingBytes, targetPendingBytes };
  });
  return {
    upload: Effect.fn("LegacyAttachmentUploads.upload")(function* (args: {
      readonly params: { readonly threadId: ThreadId };
      readonly payload: typeof EnvironmentOrchestrationAttachmentUpload.Type;
    }) {
      const source = args.payload.file;
      const fileInfo = yield* fileSystem
        .stat(source.path)
        .pipe(Effect.catch(() => failEnvironmentInvalidRequest("invalid_attachment")));
      const sizeBytes = Number(fileInfo.size);
      if (
        fileInfo.type !== "File" ||
        sizeBytes <= 0 ||
        sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES
      ) {
        return yield* failEnvironmentInvalidRequest("invalid_attachment");
      }

      const attachmentId = createUploadAttachmentId(args.params.threadId, args.payload.uploadId);
      const name = sanitizeAttachmentFileName(path.basename(source.name.trim()));
      if (!attachmentId || name.length === 0) {
        return yield* failEnvironmentInvalidRequest("invalid_attachment");
      }
      const attachment: ChatStoredFileAttachment = {
        type: "file",
        id: attachmentId,
        name,
        mimeType: (source.contentType.trim() || "application/octet-stream")
          .toLowerCase()
          .slice(0, 100),
        sizeBytes,
      };
      const destination = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!destination) {
        return yield* failEnvironmentInvalidRequest("invalid_attachment");
      }

      const persistedAttachment = yield* attachmentUploadSemaphore.withPermit(
        Effect.gen(function* () {
          const [targetThread, liveAttachments] = yield* Effect.all([
            threads.getThreadShell(args.params.threadId),
            liveAttachmentRows(),
          ]).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
            ),
          );
          if (targetThread === null || targetThread.deletedAt !== null)
            return yield* failEnvironmentNotFound("thread_not_found");
          const liveAttachmentIds = liveAttachments.map((row) => row.id);
          const stored = liveAttachments.find((row) => row.id === attachmentId);
          const existingAttachment = stored
            ? compiledDecodeOption1(stored.attachment_json)
            : Option.none();
          if (Option.isSome(existingAttachment)) {
            if (!isChatFileAttachment(existingAttachment.value)) {
              return yield* failEnvironmentInvalidRequest("invalid_attachment");
            }
            return existingAttachment.value;
          }
          const referencedAttachmentIds = new Set(liveAttachmentIds);
          if (referencedAttachmentIds.has(attachmentId)) {
            return yield* failEnvironmentInvalidRequest("invalid_attachment");
          }
          const previousPendingPath = yield* resolveAttachmentPathById({
            attachmentsDir: serverConfig.attachmentsDir,
            attachmentId,
          });
          if (previousPendingPath && previousPendingPath !== destination) {
            yield* fileSystem
              .remove(previousPendingPath, { force: true })
              .pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_attachment_upload_failed", cause),
                ),
              );
          }
          const pending = yield* reclaimPendingAttachments({
            referencedAttachmentIds,
            targetThreadId: args.params.threadId,
            replacementAttachmentId: attachmentId,
          }).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_attachment_upload_failed", cause),
            ),
          );
          if (exceedsPendingAttachmentCapacity({ ...pending, incomingBytes: sizeBytes })) {
            return yield* failEnvironmentInvalidRequest("invalid_attachment");
          }

          yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
            Effect.flatMap(() => fileSystem.copyFile(source.path, destination)),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_attachment_upload_failed", cause),
            ),
          );
          const persistedInfo = yield* fileSystem
            .stat(destination)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_attachment_upload_failed", cause),
              ),
            );
          if (persistedInfo.type !== "File" || Number(persistedInfo.size) !== sizeBytes) {
            yield* fileSystem.remove(destination, { force: true }).pipe(Effect.ignore);
            return yield* failEnvironmentInvalidRequest("invalid_attachment");
          }
          return attachment;
        }),
      );
      return persistedAttachment;
    }),
    delete: Effect.fn("LegacyAttachmentUploads.delete")(function* (args: {
      readonly params: { readonly threadId: ThreadId; readonly attachmentId: string };
    }) {
      return yield* attachmentUploadSemaphore.withPermit(
        Effect.gen(function* () {
          const [targetThread, liveAttachments] = yield* Effect.all([
            threads.getThreadShell(args.params.threadId),
            liveAttachmentRows(),
          ]).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
            ),
          );
          if (targetThread === null || targetThread.deletedAt !== null)
            return yield* failEnvironmentNotFound("thread_not_found");
          const liveAttachmentIds = liveAttachments.map((row) => row.id);

          if (
            !isCanonicalAttachmentIdOwnedByThread(args.params.attachmentId, args.params.threadId)
          ) {
            return yield* failEnvironmentInvalidRequest("invalid_attachment");
          }
          const referenced = liveAttachmentIds.includes(args.params.attachmentId);
          if (referenced) {
            return yield* failEnvironmentInvalidRequest("invalid_attachment");
          }

          const attachmentPath = yield* resolveAttachmentPathById({
            attachmentsDir: serverConfig.attachmentsDir,
            attachmentId: args.params.attachmentId,
          });
          if (!attachmentPath) {
            return { attachmentId: args.params.attachmentId, deleted: false };
          }
          yield* fileSystem
            .remove(attachmentPath, { force: true })
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_attachment_delete_failed", cause),
              ),
            );
          return { attachmentId: args.params.attachmentId, deleted: true };
        }),
      );
    }),
  };
});

const compiledDecodeOption1 = Schema.decodeOption(Schema.fromJsonString(ChatFileAttachment));
