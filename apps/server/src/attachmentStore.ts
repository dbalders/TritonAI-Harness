// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
const ATTACHMENT_ID_FILE_EXTENSION_PATTERN = "[a-z0-9]{1,10}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})(?:-(${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}))?$`,
  "i",
);

export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";
export const PENDING_ATTACHMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PARTIAL_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

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
  return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ? "_pending" : segment;
}

export function attachmentFileExtension(fileName: string): string {
  const extension = NodePath.extname(fileName).toLowerCase();
  // ".part" is reserved for in-flight uploads; a stored "archive.part" would
  // look stale to sweepStalePendingAttachments and get deleted.
  if (extension === ".part" || !/^\.[a-z0-9]{1,10}$/.test(extension)) {
    return ".bin";
  }
  return extension;
}

function attachmentIdExtensionSuffix(extension: string | undefined): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.replace(/^\./, "").toLowerCase();
  return new RegExp(`^${ATTACHMENT_ID_FILE_EXTENSION_PATTERN}$`).test(normalized)
    ? `-${normalized}`
    : "-bin";
}

export function createPendingAttachmentId(extension?: string): string {
  return `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}${attachmentIdExtensionSuffix(extension)}`;
}

export function parseAttachmentUuid(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId.match(ATTACHMENT_ID_PATTERN)?.[2]?.toLowerCase() ?? null;
}

export function parseAttachmentFileExtension(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  return normalizedId.match(ATTACHMENT_ID_PATTERN)?.[3]?.toLowerCase() ?? null;
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
  extension?: string,
): string | null {
  const threadSegment = toCanonicalThreadAttachmentSegment(threadId);
  const normalizedUploadId = uploadId.trim().toLowerCase();
  if (!threadSegment || !ATTACHMENT_UPLOAD_ID_PATTERN.test(normalizedUploadId)) {
    return null;
  }
  return `${threadSegment}-${normalizedUploadId}${attachmentIdExtensionSuffix(extension)}`;
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

/** Null for attachment types this build does not know; callers skip those. */
export function attachmentRelativePath(attachment: ChatAttachment): string | null {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file":
      return `${attachment.id}${attachmentFileExtension(attachment.name)}`;
    default:
      return null;
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  const relativePath = attachmentRelativePath(input.attachment);
  if (!relativePath) {
    return null;
  }
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath,
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
  const fileExtension = parseAttachmentFileExtension(normalizedId);
  if (fileExtension) {
    const filePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}.${fileExtension.toLowerCase()}`,
    });
    return filePath && NodeFS.existsSync(filePath) ? filePath : null;
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

export type AttachmentClaimPlan =
  | {
      readonly ok: true;
      readonly finalId: string;
      readonly currentPath: string;
      readonly finalPath: string;
    }
  | { readonly ok: false; readonly reason: string };

export const planAttachmentClaim = Effect.fn("planAttachmentClaim")(function* (input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachmentId: string;
}) {
  const uuid = parseAttachmentUuid(input.attachmentId);
  const requestedSegment = parseThreadSegmentFromAttachmentId(input.attachmentId);
  if (!uuid || !requestedSegment) {
    return { ok: false, reason: "invalid attachment id" } as const;
  }

  if (!toSafeThreadAttachmentSegment(input.threadId)) {
    return { ok: false, reason: "invalid thread id" } as const;
  }
  if (requestedSegment !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return { ok: false, reason: "attachment must be a pending upload" } as const;
  }

  const currentPath = yield* resolveAttachmentPathById({
    attachmentsDir: input.attachmentsDir,
    attachmentId: input.attachmentId,
  });
  if (!currentPath) {
    return { ok: false, reason: "attachment not found (removed or expired)" } as const;
  }
  const fileExtension = parseAttachmentFileExtension(input.attachmentId) ?? undefined;
  const finalId = createAttachmentId(input.threadId, undefined, fileExtension);
  if (!finalId) {
    return { ok: false, reason: "failed to create attachment id" } as const;
  }

  const expectedFinalPath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${finalId}${NodePath.extname(currentPath)}`,
  });
  if (!expectedFinalPath) {
    return { ok: false, reason: "failed to resolve attachment path" } as const;
  }
  return {
    ok: true,
    finalId,
    currentPath,
    finalPath: expectedFinalPath,
  } as const;
});

export function sweepStalePendingAttachments(input: {
  readonly attachmentsDir: string;
  readonly nowMs: number;
}): { readonly deleted: number } {
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(input.attachmentsDir);
  } catch {
    return { deleted: 0 };
  }

  let deleted = 0;
  for (const entry of entries) {
    const isPartial = entry.endsWith(".part");
    if (!isPartial) {
      const attachmentId = parseAttachmentIdFromRelativePath(entry);
      if (
        !attachmentId ||
        parseThreadSegmentFromAttachmentId(attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
      ) {
        continue;
      }
    }

    const resolved = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: entry,
    });
    if (!resolved) {
      continue;
    }
    try {
      const maxAgeMs = isPartial ? PARTIAL_UPLOAD_MAX_AGE_MS : PENDING_ATTACHMENT_MAX_AGE_MS;
      if (input.nowMs - NodeFS.statSync(resolved).mtimeMs > maxAgeMs) {
        NodeFS.unlinkSync(resolved);
        deleted += 1;
      }
    } catch {
      continue;
    }
  }

  return { deleted };
}

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
