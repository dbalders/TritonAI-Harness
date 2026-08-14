import type { ChatFileAttachment } from "@t3tools/contracts";

export function appendFileAttachmentPrompt(input: {
  readonly prompt: string | undefined;
  readonly attachments: ReadonlyArray<ChatFileAttachment>;
  readonly resolvePath: (attachment: ChatFileAttachment) => string | null;
}): string | undefined {
  if (input.attachments.length === 0) {
    return input.prompt;
  }

  const lines = ["# Files mentioned by the user:"];
  for (const attachment of input.attachments) {
    const attachmentPath = input.resolvePath(attachment);
    if (attachmentPath) {
      lines.push(`## ${attachment.name}: ${attachmentPath}`);
    }
  }
  if (lines.length === 1) {
    return input.prompt;
  }

  const fileContext = lines.join("\n");
  const prompt = input.prompt?.trim();
  return prompt ? `${prompt}\n\n${fileContext}` : fileContext;
}
