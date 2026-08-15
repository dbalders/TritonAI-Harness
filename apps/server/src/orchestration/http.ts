import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type OrchestrationReadModel,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  createAttachmentId,
  isAttachmentIdOwnedByThread,
  isCanonicalAttachmentIdOwnedByThread,
  parseAttachmentIdFromRelativePath,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";

const PENDING_ATTACHMENT_TTL_MS = 60 * 60 * 1000;
const MAX_GLOBAL_PENDING_ATTACHMENT_BYTES = 10 * PROVIDER_SEND_TURN_MAX_FILE_BYTES;

export function isPendingAttachmentExpired(input: {
  readonly modifiedAt: number | null;
  readonly now: number;
}): boolean {
  return input.modifiedAt !== null && input.now - input.modifiedAt > PENDING_ATTACHMENT_TTL_MS;
}

export function exceedsPendingAttachmentCapacity(input: {
  readonly targetPendingBytes: number;
  readonly globalPendingBytes: number;
  readonly incomingBytes: number;
}): boolean {
  return (
    input.targetPendingBytes + input.incomingBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES ||
    input.globalPendingBytes + input.incomingBytes > MAX_GLOBAL_PENDING_ATTACHMENT_BYTES
  );
}

export function sanitizeAttachmentFileName(fileName: string): string {
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

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const attachmentUploadSemaphore = yield* Semaphore.make(1);

    const reclaimPendingAttachments = Effect.fn(
      "environment.orchestration.reclaimPendingAttachments",
    )(function* (input: {
      readonly snapshot: OrchestrationReadModel;
      readonly targetThreadId: string;
      readonly replacementAttachmentId: string;
    }) {
      const referencedIds = new Set(
        input.snapshot.threads.flatMap((thread) =>
          thread.messages.flatMap((message) =>
            (message.attachments ?? []).map((attachment) => attachment.id),
          ),
        ),
      );
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
        if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) continue;
        const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
        if (
          !attachmentId ||
          referencedIds.has(attachmentId) ||
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
        if (isAttachmentIdOwnedByThread(attachmentId, input.targetThreadId)) {
          targetPendingBytes += sizeBytes;
        }
      }

      return { globalPendingBytes, targetPendingBytes };
    });

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "uploadAttachment",
        Effect.fn("environment.orchestration.uploadAttachment")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);

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

          const attachmentId = createAttachmentId(args.params.threadId, args.payload.uploadId);
          const name = sanitizeAttachmentFileName(path.basename(source.name.trim()));
          if (!attachmentId || name.length === 0) {
            return yield* failEnvironmentInvalidRequest("invalid_attachment");
          }
          const attachment = {
            type: "file" as const,
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
              const snapshot = yield* projectionSnapshotQuery
                .getSnapshot()
                .pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
                  ),
                );
              const targetThread = snapshot.threads.find(
                (thread) => thread.id === args.params.threadId,
              );
              if (!targetThread) {
                return yield* failEnvironmentNotFound("thread_not_found");
              }
              const referencedByAnotherThread = snapshot.threads.some(
                (thread) =>
                  thread.id !== args.params.threadId &&
                  thread.messages.some((message) =>
                    (message.attachments ?? []).some((candidate) => candidate.id === attachmentId),
                  ),
              );
              if (referencedByAnotherThread) {
                return yield* failEnvironmentInvalidRequest("invalid_attachment");
              }
              const existingAttachment = targetThread.messages
                .flatMap((message) => message.attachments ?? [])
                .find((candidate) => candidate.id === attachmentId);
              if (existingAttachment) {
                if (existingAttachment.type !== "file") {
                  return yield* failEnvironmentInvalidRequest("invalid_attachment");
                }
                return existingAttachment;
              }
              const previousPendingPath = resolveAttachmentPathById({
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
                snapshot,
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
      )
      .handle(
        "deleteAttachment",
        Effect.fn("environment.orchestration.deleteAttachment")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);

          const snapshot = yield* projectionSnapshotQuery
            .getSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (!snapshot.threads.some((thread) => thread.id === args.params.threadId)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }

          if (
            !isCanonicalAttachmentIdOwnedByThread(args.params.attachmentId, args.params.threadId)
          ) {
            return yield* failEnvironmentInvalidRequest("invalid_attachment");
          }
          const referenced = snapshot.threads.some((thread) =>
            thread.messages.some((message) =>
              (message.attachments ?? []).some(
                (attachment) => attachment.id === args.params.attachmentId,
              ),
            ),
          );
          if (referenced) {
            return yield* failEnvironmentInvalidRequest("invalid_attachment");
          }

          const attachmentPath = resolveAttachmentPathById({
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
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          return yield* orchestrationEngine
            .dispatch(normalizedCommand)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
        }),
      );
  }),
);
