import type { ChatFileAttachment } from "@t3tools/contracts";

export function appendFileAttachmentPrompt(input: {
  readonly prompt: string | undefined;
  readonly attachments: ReadonlyArray<ChatFileAttachment>;
  readonly resolvePath: (attachment: ChatFileAttachment) => string | null;
}): string | undefined {
  if (input.attachments.length === 0) {
    return input.prompt;
  }

  const lines = [
    "# Files mentioned by the user:",
    "",
    "Inspect these files with format-appropriate tools. Start with bounded samples rather than printing entire files, and validate derived values before answering.",
  ];
  let resolvedAttachmentCount = 0;
  for (const attachment of input.attachments) {
    const attachmentPath = input.resolvePath(attachment);
    if (attachmentPath) {
      resolvedAttachmentCount += 1;
      lines.push(
        "",
        `## ${attachment.name}`,
        `- Path: ${attachmentPath}`,
        `- Media type: ${attachment.mimeType}`,
        `- Size: ${attachment.sizeBytes} bytes`,
      );
    }
  }
  if (resolvedAttachmentCount === 0) {
    return input.prompt;
  }

  const fileContext = lines.join("\n");
  const prompt = input.prompt?.trim();
  return prompt ? `${prompt}\n\n${fileContext}` : fileContext;
}
