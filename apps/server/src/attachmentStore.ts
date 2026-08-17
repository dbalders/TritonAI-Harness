// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_HASH_CHARS = 16;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_UPLOAD_ID_PATTERN = new RegExp(`^${ATTACHMENT_ID_UUID_PATTERN}$`, "i");
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment;
}

export function toCanonicalThreadAttachmentSegment(threadId: string): string | null {
  const legacySegment = toSafeThreadAttachmentSegment(threadId);
  if (!legacySegment) return null;
  const digest = NodeCrypto.createHash("sha256")
    .update(threadId)
    .digest("hex")
    .slice(0, ATTACHMENT_ID_THREAD_HASH_CHARS);
  const prefix = legacySegment
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS - ATTACHMENT_ID_THREAD_HASH_CHARS - 1)
    .replace(/[-_]+$/g, "");
  return prefix.length > 0 ? `${prefix}-${digest}` : digest;
}

export function createAttachmentId(
  threadId: string,
  uploadId: string = NodeCrypto.randomUUID(),
): string | null {
  const threadSegment = toCanonicalThreadAttachmentSegment(threadId);
  const normalizedUploadId = uploadId.trim().toLowerCase();
  if (!threadSegment || !ATTACHMENT_UPLOAD_ID_PATTERN.test(normalizedUploadId)) {
    return null;
  }
  return `${threadSegment}-${normalizedUploadId}`;
}

export function isAttachmentIdOwnedByThread(attachmentId: string, threadId: string): boolean {
  const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
  if (!attachmentThreadSegment) return false;
  return (
    attachmentThreadSegment === toCanonicalThreadAttachmentSegment(threadId) ||
    attachmentThreadSegment === toSafeThreadAttachmentSegment(threadId)
  );
}

export function isCanonicalAttachmentIdOwnedByThread(
  attachmentId: string,
  threadId: string,
): boolean {
  return (
    parseThreadSegmentFromAttachmentId(attachmentId) ===
    toCanonicalThreadAttachmentSegment(threadId)
  );
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

export function attachmentRelativePath(attachment: ChatAttachment): string {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file":
      return `${attachment.id}.bin`;
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: attachmentRelativePath(input.attachment),
  });
}

export const resolveAttachmentPathById = Effect.fn("resolveAttachmentPathById")(function* (input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    const isFile = maybePath
      ? yield* fileSystem.stat(maybePath).pipe(
          Effect.map((info) => info.type === "File"),
          Effect.orElseSucceed(() => false),
        )
      : false;
    if (maybePath && isFile) {
      return maybePath;
    }
  }
  const entries = yield* fileSystem
    .readDirectory(input.attachmentsDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  for (const entry of entries.toSorted()) {
    if (parseAttachmentIdFromRelativePath(entry) !== normalizedId) continue;
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: entry,
    });
    const isFile = maybePath
      ? yield* fileSystem.stat(maybePath).pipe(
          Effect.map((info) => info.type === "File"),
          Effect.orElseSucceed(() => false),
        )
      : false;
    if (maybePath && isFile) return maybePath;
  }
  return null;
});

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}
