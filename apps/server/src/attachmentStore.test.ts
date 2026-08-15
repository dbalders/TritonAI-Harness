// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  attachmentRelativePath,
  createAttachmentId,
  inferFileExtension,
  isAttachmentIdOwnedByThread,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toMatch(/^thread-foo-[0-9a-f]{16}$/);
    expect(threadSegment).toBe(threadSegment?.toLowerCase());
  });

  it("creates deterministic ids for idempotent upload retries", () => {
    const uploadId = "00000000-0000-4000-8000-000000000005";
    const attachmentId = createAttachmentId("Thread.One", uploadId);

    expect(attachmentId).toBe(createAttachmentId("Thread.One", uploadId));
    expect(attachmentId).not.toBe(createAttachmentId("thread-one", uploadId));
    expect(attachmentId && isAttachmentIdOwnedByThread(attachmentId, "Thread.One")).toBe(true);
    expect(createAttachmentId("Thread.One", "not-a-uuid")).toBeNull();
  });

  it("continues to recognize legacy attachment ownership", () => {
    expect(
      isAttachmentIdOwnedByThread("thread-one-00000000-0000-4000-8000-000000000005", "Thread.One"),
    ).toBe(true);
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("uses a safe final extension for generic files", () => {
    expect(inferFileExtension("notes.TXT")).toBe(".txt");
    expect(inferFileExtension("archive.tar.gz")).toBe(".gz");
    expect(inferFileExtension("no-extension")).toBe(".bin");
    expect(inferFileExtension("unsafe.<script>")).toBe(".bin");

    expect(
      attachmentRelativePath({
        type: "file",
        id: "thread-file-00000000-0000-4000-8000-000000000001",
        name: "requirements.PDF",
        mimeType: "application/pdf",
        sizeBytes: 12,
      }),
    ).toBe("thread-file-00000000-0000-4000-8000-000000000001.pdf");
  });

  it("resolves generic attachment extensions from disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-file-00000000-0000-4000-8000-000000000001";
      const textPath = NodePath.join(attachmentsDir, `${attachmentId}.txt`);
      NodeFS.writeFileSync(textPath, "hello");

      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId })).toBe(textPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
