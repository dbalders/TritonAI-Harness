import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });

  it("replaces both timestamps when a goal bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.goal.set",
      commandId: CommandId.make("command-goal-bootstrap"),
      threadId: ThreadId.make("thread-goal"),
      objective: "Finish the goal flow",
      status: "active",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Finish the goal flow",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.goal.set");
    if (result.type !== "thread.goal.set") {
      throw new Error("Expected a thread.goal.set command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("normalizeDispatchCommand", () => {
  it.effect("rejects an oversized image batch before persisting attachments", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig;
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-oversized-images"),
        threadId: ThreadId.make("thread-oversized-images"),
        message: {
          messageId: MessageId.make("message-oversized-images"),
          role: "user",
          text: "Inspect these images",
          attachments: Array.from({ length: 6 }, (_, index) => ({
            type: "image" as const,
            name: `image-${index}.png`,
            mimeType: "image/png",
            sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
            dataUrl: "data:image/png;base64,AA==",
          })),
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      };

      const error = yield* normalizeDispatchCommand(command).pipe(Effect.flip);

      expect(error.message).toBe(
        "The combined uploaded attachment size exceeds the 50 MiB turn limit.",
      );
      expect(yield* fileSystem.readDirectory(attachmentsDir)).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-test-" }),
          WorkspacePaths.layer,
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );
});
