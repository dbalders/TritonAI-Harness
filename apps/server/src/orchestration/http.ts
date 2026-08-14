import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

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

          const attachmentId = createAttachmentId(args.params.threadId);
          const name = path
            .basename(source.name.trim())
            .split("")
            .map((character) => {
              const codePoint = character.codePointAt(0) ?? 0;
              return codePoint < 32 || codePoint === 127 ? " " : character;
            })
            .join("")
            .trim()
            .slice(0, 255);
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

          yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
            Effect.flatMap(() => fileSystem.copyFile(source.path, destination)),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_attachment_upload_failed", cause),
            ),
          );
          return attachment;
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
