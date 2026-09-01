// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  attachmentFileExtension,
  attachmentRelativePath,
  createAttachmentId,
  createPendingAttachmentId,
  isAttachmentIdOwnedByThread,
  parseAttachmentFileExtension,
  parseAttachmentUuid,
  planAttachmentClaim,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
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

  it("preserves safe file extensions in attachment ids and paths", () => {
    const attachmentId = createPendingAttachmentId(".PDF");

    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("pending");
    expect(parseAttachmentUuid(attachmentId)).toMatch(/^[a-f0-9-]{36}$/);
    expect(parseAttachmentFileExtension(attachmentId)).toBe("pdf");
    expect(attachmentFileExtension("report.PDF")).toBe(".pdf");
    expect(attachmentFileExtension("report")).toBe(".bin");
    expect(attachmentFileExtension("report.extensiontoolong")).toBe(".bin");
    // ".part" is the in-flight upload suffix; storing it would make the file
    // look like a stale partial to the sweep.
    expect(attachmentFileExtension("archive.part")).toBe(".bin");
    expect(
      createAttachmentId("x".repeat(80), "00000000-0000-4000-8000-000000000001", ".abcdefghij")
        ?.length,
    ).toBeLessThanOrEqual(128);
  });

  it.effect("resolves generic attachments without scanning the attachment directory", () =>
    Effect.gen(function* () {
      const attachmentsDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-file-attachment-"),
      );
      try {
        const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001-zip";
        const archivePath = NodePath.join(attachmentsDir, `${attachmentId}.zip`);
        NodeFS.writeFileSync(archivePath, Buffer.from("archive"));

        expect(yield* resolveAttachmentPathById({ attachmentsDir, attachmentId })).toBe(
          archivePath,
        );
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("plans pending attachment claims with direct filename lookups", () =>
    Effect.gen(function* () {
      const attachmentsDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-attachment-claim-"),
      );
      try {
        const uuid = "00000000-0000-4000-8000-000000000001";
        const pendingId = `pending-${uuid}-png`;
        const pendingPath = NodePath.join(attachmentsDir, `${pendingId}.png`);
        NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

        const claim = yield* planAttachmentClaim({
          attachmentsDir,
          threadId: "thread-1",
          attachmentId: pendingId,
        });
        expect(claim).toMatchObject({
          ok: true,
          currentPath: pendingPath,
        });
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves attachment path by id using the extension that exists on disk", () =>
    Effect.gen(function* () {
      const attachmentsDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
      );
      try {
        const attachmentId = "thread-1-attachment";
        const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
        NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

        const resolved = yield* resolveAttachmentPathById({ attachmentsDir, attachmentId });
        expect(resolved).toBe(pngPath);
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("preserves generic file extensions in attachment paths", () => {
    expect(
      attachmentRelativePath({
        type: "file",
        id: "thread-file-00000000-0000-4000-8000-000000000001-pdf",
        name: "requirements.PDF",
        mimeType: "application/pdf",
        sizeBytes: 12,
      }),
    ).toBe("thread-file-00000000-0000-4000-8000-000000000001-pdf.pdf");
  });

  it.effect("resolves a generic attachment from its deterministic blob path", () =>
    Effect.gen(function* () {
      const attachmentsDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
      );
      try {
        const attachmentId = "thread-file-00000000-0000-4000-8000-000000000001";
        const textPath = NodePath.join(attachmentsDir, `${attachmentId}.bin`);
        NodeFS.writeFileSync(textPath, "hello");

        expect(yield* resolveAttachmentPathById({ attachmentsDir, attachmentId })).toBe(textPath);
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps legacy attachment extensions resolvable", () =>
    Effect.gen(function* () {
      const attachmentsDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
      );
      try {
        const attachmentId = "thread-file-00000000-0000-4000-8000-000000000002";
        const legacyPath = NodePath.join(attachmentsDir, `${attachmentId}.html`);
        NodeFS.writeFileSync(legacyPath, "<p>legacy</p>");

        expect(yield* resolveAttachmentPathById({ attachmentsDir, attachmentId })).toBe(legacyPath);
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns null when no attachment file exists for the id", () =>
    Effect.gen(function* () {
      const attachmentsDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
      );
      try {
        const resolved = yield* resolveAttachmentPathById({
          attachmentsDir,
          attachmentId: "thread-1-missing",
        });
        expect(resolved).toBeNull();
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("removes expired pending and partial files without touching thread attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-sweep-"),
    );
    try {
      const now = 1_800_000_000_000;
      const oldTimeSeconds = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const uuid = "00000000-0000-4000-8000-000000000002";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      const pendingFilePath = NodePath.join(attachmentsDir, `pending-${uuid}-pdf.pdf`);
      const threadPath = NodePath.join(attachmentsDir, `thread-1-${uuid}.png`);
      const partialPath = NodePath.join(attachmentsDir, `${uuid}.part`);
      for (const filePath of [pendingPath, pendingFilePath, threadPath, partialPath]) {
        NodeFS.writeFileSync(filePath, Buffer.from("pixels"));
        NodeFS.utimesSync(filePath, oldTimeSeconds, oldTimeSeconds);
      }

      expect(sweepStalePendingAttachments({ attachmentsDir, nowMs: now })).toEqual({ deleted: 3 });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(pendingFilePath)).toBe(false);
      expect(NodeFS.existsSync(partialPath)).toBe(false);
      expect(NodeFS.existsSync(threadPath)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
