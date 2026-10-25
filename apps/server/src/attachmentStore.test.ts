import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { createUploadAttachmentId } from "./attachmentStore.ts";
import { isAttachmentIdOwnedByThread } from "./attachmentStore.ts";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeOS from "node:os";

import * as NodePath from "node:path";

import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";

import {
  chatAttachmentStableKey,
  createAttachmentId,
  createDeterministicAttachmentId,
  planAttachmentClaim,
  parseThreadSegmentFromAttachmentId,
  sweepStalePendingAttachments,
  threadHtmlRenderAttachmentIds,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("derives stable attachment ids for idempotent message retries", () => {
    const first = createDeterministicAttachmentId("thread-1", "message-1:0");
    const retry = createDeterministicAttachmentId("thread-1", "message-1:0");
    const next = createDeterministicAttachmentId("thread-1", "message-1:1");

    expect(first).toBe(retry);
    expect(next).not.toBe(first);
    expect(first && parseThreadSegmentFromAttachmentId(first)).toBe("thread-1");
  });

  it("gives a queued edit's new image its own id instead of an earlier image's", () => {
    const imageA = new Uint8Array([1, 2, 3]);
    const imageB = new Uint8Array([4, 5, 6]);
    const sent = createDeterministicAttachmentId(
      "thread-1",
      chatAttachmentStableKey("message-1", 0, imageA),
    );
    const retried = createDeterministicAttachmentId(
      "thread-1",
      chatAttachmentStableKey("message-1", 0, imageA),
    );
    const edited = createDeterministicAttachmentId(
      "thread-1",
      chatAttachmentStableKey("message-1", 0, imageB),
    );

    expect(retried).toBe(sent);
    expect(edited).not.toBe(sent);
  });

  it("keeps deterministic ids distinct when sanitized thread segments collide", () => {
    const dotted = createDeterministicAttachmentId("thread.a", "message-1:0");
    const dashed = createDeterministicAttachmentId("thread-a", "message-1:0");

    expect(dotted).toBeTruthy();
    expect(dashed).toBeTruthy();
    expect(dotted).not.toBe(dashed);
    expect(dotted && parseThreadSegmentFromAttachmentId(dotted)).toBe("thread-a");
    expect(dashed && parseThreadSegmentFromAttachmentId(dashed)).toBe("thread-a");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("creates deterministic ids for idempotent upload retries", () => {
    const uploadId = "00000000-0000-4000-8000-000000000005";
    const attachmentId = createUploadAttachmentId("Thread.One", uploadId);

    expect(attachmentId).toBe(createUploadAttachmentId("Thread.One", uploadId));
    expect(attachmentId).not.toBe(createUploadAttachmentId("thread-one", uploadId));
    expect(attachmentId && isAttachmentIdOwnedByThread(attachmentId, "Thread.One")).toBe(true);
    expect(createUploadAttachmentId("Thread.One", "not-a-uuid")).toBeNull();
  });

  it("continues to recognize legacy attachment ownership", () => {
    expect(
      isAttachmentIdOwnedByThread("thread-one-00000000-0000-4000-8000-000000000005", "Thread.One"),
    ).toBe(true);
  });

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

describe("threadHtmlRenderAttachmentIds", () => {
  it("returns pages this thread published and skips other threads' and failed calls", () => {
    const own = createAttachmentId("thread-a", "html")!;
    const other = createAttachmentId("thread-b", "html")!;
    const render = (attachmentId: string, extra = {}) => ({
      toolName: "mcp__t3-code__html_render",
      output: [
        {
          type: "text",
          text: JSON.stringify({ htmlRender: { attachmentId, title: "x", height: 300 }, ...extra }),
        },
      ],
    });
    expect(
      threadHtmlRenderAttachmentIds("thread-a", [
        render(own),
        render(other),
        render(createAttachmentId("thread-a", "html")!, { isError: true }),
        { toolName: "mcp__t3-code__html_preview", output: render(own).output },
      ]),
    ).toEqual([own]);
  });

  it("includes captured MCP App documents from any tool", () => {
    const app = createAttachmentId("thread-a", "html")!;
    expect(
      threadHtmlRenderAttachmentIds("thread-a", [
        {
          toolName: "weather.get_weather",
          output: {
            t3McpApp: {
              attachmentId: app,
              server: "weather",
              tool: "get_weather",
              resourceUri: "ui://weather/dashboard",
            },
            result: { content: [] },
          },
        },
      ]),
    ).toEqual([app]);
  });
});
