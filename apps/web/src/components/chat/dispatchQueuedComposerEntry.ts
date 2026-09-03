import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/shell";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { MessageId } from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";

import type { QueuedComposerEntry } from "../../composerQueueStore";
import { appendElementContextsToPrompt } from "../../lib/elementContext";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { appendPreviewAnnotationPrompt } from "../../lib/previewAnnotation";
import { appendTerminalContextsToPrompt } from "../../lib/terminalContext";
import { newMessageId } from "../../lib/utils";
import { appendReviewCommentsToPrompt } from "../../reviewCommentContext";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import {
  deriveComposerSendState,
  readFileAsDataUrl,
  resolveThreadMetadataUpdateForNextTurn,
} from "../ChatView.logic";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { formatOutgoingPrompt } from "./composerDispatch";

const ATTACHMENT_ONLY_PROMPT =
  "[User attached one or more files without additional text. Inspect the attached files and respond using the conversation context.]";

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
  const { trimmedPrompt, sendableTerminalContexts, hasSendableContent } = deriveComposerSendState({
    prompt: entry.prompt,
    imageCount: attachments.length,
    terminalContexts: entry.terminalContexts,
    elementContextCount:
      entry.elementContexts.length + entry.previewAnnotations.length + entry.reviewComments.length,
  });
  if (!hasSendableContent) {
    throw new Error("The queued message no longer has sendable content.");
  }

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
        if (attachment.file === null) {
          throw new Error(`File '${attachment.name}' must be attached again.`);
        }
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

  const messageWithContexts = appendElementContextsToPrompt(
    appendTerminalContextsToPrompt(entry.prompt, sendableTerminalContexts),
    entry.elementContexts,
  );
  const messageWithAnnotations = entry.previewAnnotations.reduce(
    (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
    messageWithContexts,
  );
  const messageText = appendReviewCommentsToPrompt(messageWithAnnotations, entry.reviewComments);
  const outgoingText = formatOutgoingPrompt({
    provider: entry.selectedProvider,
    model: entry.selectedModel,
    models: entry.selectedProviderModels,
    effort: entry.selectedPromptEffort,
    text: messageText || ATTACHMENT_ONLY_PROMPT,
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
