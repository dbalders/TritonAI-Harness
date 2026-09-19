import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type MessageId } from "@t3tools/contracts";
import { assertQueuedComputerUseReady } from "./queuedComputerUsePreflight";
import { environmentPresentations } from "../../state/presentation";
import { desktopLocalBackendId } from "../../connection/desktopLocal";
import { truncate } from "@t3tools/shared/String";

import type { QueuedComposerEntry } from "../../composerQueueStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { newMessageId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import {
  deriveComposerSendState,
  readFileAsDataUrl,
  resolveThreadMetadataUpdateForNextTurn,
} from "../ChatView.logic";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";

import { buildQueuedComposerPrompt } from "./queuedComposerPrompt";
import { getComposerPromptLengthValidationMessage } from "./composerSubmission";

function failureMessage(result: AtomCommandResult<unknown, unknown>): string {
  const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
  return error instanceof Error ? error.message : "Failed to send queued message.";
}

export async function dispatchQueuedComposerEntry(input: {
  readonly entry: QueuedComposerEntry;
  readonly thread: EnvironmentThread;
}): Promise<MessageId> {
  const { entry, thread } = input;
  const environmentId = thread.environmentId;
  const threadRef = scopeThreadRef(environmentId, thread.id);
  const attachments = [...entry.images, ...entry.files];
  const { trimmedPrompt, hasSendableContent } = deriveComposerSendState({
    prompt: entry.prompt,
    imageCount: attachments.length,
    terminalContexts: entry.terminalContexts,
    elementContextCount:
      entry.elementContexts.length + entry.previewAnnotations.length + entry.reviewComments.length,
  });
  if (!hasSendableContent) {
    throw new Error("The queued message no longer has sendable content.");
  }

  const outgoingText = buildQueuedComposerPrompt(entry);
  const validationMessage = getComposerPromptLengthValidationMessage(outgoingText);
  if (validationMessage) throw new Error(validationMessage);

  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
  const supportsAttachmentUploads = config?.environment.capabilities.attachmentUploads === true;
  const fileBlockReason = fileAttachmentCapabilityBlockReason({
    files: entry.files,
    attachmentUploadsCapabilityKnown: config !== null,
    supportsAttachmentUploads,
    maxFileAttachmentBytes:
      config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
  });
  if (fileBlockReason) throw new Error(fileBlockReason);

  const attachmentsRequiringUpload = [
    ...(supportsAttachmentUploads ? entry.images : []),
    ...entry.files.filter((attachment) => attachment.path == null),
  ];
  for (const attachment of attachmentsRequiringUpload) {
    startAttachmentUpload({ environmentId, image: attachment, draftTarget: threadRef });
  }
  if (attachmentsRequiringUpload.length > 0) {
    await awaitAttachmentUploads(attachmentsRequiringUpload.map((attachment) => attachment.id));
    if (getUploadedAttachments({ environmentId, images: attachmentsRequiringUpload }) === null) {
      throw new Error("Retry or remove failed uploads before sending.");
    }
  }

  const turnAttachments = await Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.type === "file" && attachment.path != null) {
        return {
          type: "file" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          path: attachment.path,
        };
      }
      if (attachment.type === "file" || supportsAttachmentUploads) {
        const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
        if (!uploaded) throw new Error(`Attachment '${attachment.name}' did not finish uploading.`);
        return uploaded;
      }
      if (attachment.type !== "image") {
        throw new Error("This server does not support file attachments.");
      }
      return {
        type: "image" as const,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: await readFileAsDataUrl(attachment.file),
      };
    }),
  );

  const target = appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))
    ?.entry.target;
  const localBackendId =
    target?._tag === "PrimaryConnectionTarget"
      ? PRIMARY_LOCAL_ENVIRONMENT_ID
      : target
        ? desktopLocalBackendId(target)
        : null;
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  await assertQueuedComputerUseReady({
    prompt: entry.prompt,
    provider: entry.selectedProvider,
    localDesktop: Boolean(bridge && localBackendId === PRIMARY_LOCAL_ENVIRONMENT_ID),
    usesWsl: Boolean(
      bridge
        ?.getLocalEnvironmentBootstraps()
        .some(
          (environment) =>
            environment.id === PRIMARY_LOCAL_ENVIRONMENT_ID && environment.runningDistro,
        ),
    ),
    readState: () => {
      if (!bridge) throw new Error("Desktop connection unavailable.");
      return bridge.getComputerUseState();
    },
  });

  const createdAt = new Date().toISOString();
  const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
    currentModelSelection: thread.modelSelection,
    nextModelSelection: entry.selectedModelSelection,
    currentBranch: thread.branch,
  });
  if (metadataUpdate) {
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.updateMetadata,
      { environmentId, input: { threadId: thread.id, ...metadataUpdate } },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw new Error(failureMessage(result));
  }
  if (entry.runtimeMode !== thread.runtimeMode) {
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.setRuntimeMode,
      {
        environmentId,
        input: { threadId: thread.id, runtimeMode: entry.runtimeMode, createdAt },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw new Error(failureMessage(result));
  }
  if (entry.interactionMode !== thread.interactionMode) {
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.setInteractionMode,
      {
        environmentId,
        input: { threadId: thread.id, interactionMode: entry.interactionMode, createdAt },
      },
      { reportFailure: false },
    );
    if (result._tag === "Failure") throw new Error(failureMessage(result));
  }

  const messageId = newMessageId();
  const startResult = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.startTurn,
    {
      environmentId,
      input: {
        threadId: thread.id,
        message: {
          messageId,
          role: "user",
          text: outgoingText,
          attachments: turnAttachments,
        },
        modelSelection: entry.selectedModelSelection,
        titleSeed: truncate(trimmedPrompt || attachments[0]?.name || "Queued message"),
        runtimeMode: entry.runtimeMode,
        interactionMode: entry.interactionMode,
        createdAt,
      },
    },
    { reportFailure: false },
  );
  if (startResult._tag === "Failure") throw new Error(failureMessage(startResult));

  if (attachmentsRequiringUpload.length > 0) {
    releaseDraftAttachments(attachmentsRequiringUpload);
  }
  return messageId;
}
