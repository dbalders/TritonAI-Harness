import type { QueuedComposerEntry } from "../../composerQueueStore";
import { appendElementContextsToPrompt } from "../../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../../lib/previewAnnotation";
import { appendTerminalContextsToPrompt } from "../../lib/terminalContext";
import { appendReviewCommentsToPrompt } from "../../reviewCommentContext";
import { deriveComposerSendState } from "../ChatView.logic";
import { formatOutgoingPrompt } from "./composerDispatch";
import { getComposerPromptLengthValidationMessage } from "./composerSubmission";

export function buildQueuedComposerPrompt(entry: QueuedComposerEntry): string {
  const { sendableTerminalContexts } = deriveComposerSendState({
    prompt: entry.prompt,
    imageCount: entry.images.length + entry.files.length,
    terminalContexts: entry.terminalContexts,
    elementContextCount:
      entry.elementContexts.length + entry.previewAnnotations.length + entry.reviewComments.length,
  });
  const withContexts = appendElementContextsToPrompt(
    appendTerminalContextsToPrompt(entry.prompt, sendableTerminalContexts),
    entry.elementContexts,
  );
  const withAnnotations = entry.previewAnnotations.reduce(
    (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
    withContexts,
  );
  return formatOutgoingPrompt({
    provider: entry.selectedProvider,
    model: entry.selectedModel,
    models: entry.selectedProviderModels,
    effort: entry.selectedPromptEffort,
    text:
      appendReviewCommentsToPrompt(withAnnotations, entry.reviewComments) ||
      "[User attached one or more files without additional text. Inspect the attached files and respond using the conversation context.]",
  });
}

export function getQueuedComposerValidationMessage(entry: QueuedComposerEntry): string | null {
  return getComposerPromptLengthValidationMessage(buildQueuedComposerPrompt(entry));
}
