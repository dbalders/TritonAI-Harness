// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeBuffer from "node:buffer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeZlib from "node:zlib";
import { vi } from "vite-plus/test";

import {
  INTEGRATION_FILE_MAX_BYTES,
  INTEGRATION_FILE_MAX_DOCX_COMPRESSION_RATIO,
  INTEGRATION_FILE_MAX_NAME_BYTES,
  INTEGRATION_FILE_MAX_UNIQUE_BYTES_GLOBAL,
  INTEGRATION_FILE_MAX_UNIQUE_FILES_GLOBAL,
  INTEGRATION_FILE_MAX_UNIQUE_FILES_PER_SESSION,
  INTEGRATION_FILE_RESERVED_PREFIX,
  IntegrationFileMaterializer,
  isPrivateIntegrationFileStat,
  type IntegrationFileMaterializationInput,
} from "./IntegrationFileMaterializer.ts";

const fileSystemFailure = vi.hoisted(() => ({
  finalUnlinkPaths: new Set<string>(),
  failPublication: false,
  removeBeforeOpenPath: null as string | null,
  stagedPath: null as string | null,
  unlinkPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const simulatedFailure = () =>
    Object.assign(new Error("simulated filesystem failure"), {
      code: "EPERM",
    });
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      if (path === fileSystemFailure.removeBeforeOpenPath) {
        fileSystemFailure.removeBeforeOpenPath = null;
        await actual.unlink(path);
      }
      return actual.open(...args);
    }),
    link: vi.fn(async (...args: Parameters<typeof actual.link>) => {
      if (fileSystemFailure.failPublication) {
        fileSystemFailure.stagedPath = String(args[0]);
        throw simulatedFailure();
      }
      return actual.link(...args);
    }),
    unlink: vi.fn(async (...args: Parameters<typeof actual.unlink>) => {
      const path = String(args[0]);
      if (
        path === fileSystemFailure.unlinkPath ||
        fileSystemFailure.finalUnlinkPaths.has(path) ||
        (fileSystemFailure.failPublication && path === fileSystemFailure.stagedPath)
      ) {
        throw simulatedFailure();
      }
      return actual.unlink(...args);
    }),
  };
});

const PDF = NodeBuffer.Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "utf8");
const TEXT = NodeBuffer.Buffer.from("A bounded integration file fixture.\n", "utf8");
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function input(
  bytes: Uint8Array = TEXT,
  name = "fixture.txt",
  mediaType = "text/plain",
): IntegrationFileMaterializationInput {
  return { bytes, name, mediaType };
}

interface ZipFixtureEntry {
  readonly name: string;
  readonly contents: Uint8Array;
  readonly compressionMethod?: 0 | 8;
  readonly crc?: number;
  readonly uncompressedSize?: number;
}

function zipLocalEntry(entry: ZipFixtureEntry): NodeBuffer.Buffer {
  const { name, contents } = entry;
  const nameBytes = NodeBuffer.Buffer.from(name, "utf8");
  const header = NodeBuffer.Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(entry.compressionMethod ?? 0, 8);
  header.writeUInt32LE(entry.crc ?? crc32(contents), 14);
  header.writeUInt32LE(contents.byteLength, 18);
  header.writeUInt32LE(entry.uncompressedSize ?? contents.byteLength, 22);
  header.writeUInt16LE(nameBytes.byteLength, 26);
  return NodeBuffer.Buffer.concat([header, nameBytes, contents]);
}

function zipCentralEntry(entry: ZipFixtureEntry, offset: number): NodeBuffer.Buffer {
  const { name, contents } = entry;
  const nameBytes = NodeBuffer.Buffer.from(name, "utf8");
  const header = NodeBuffer.Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(entry.compressionMethod ?? 0, 10);
  header.writeUInt32LE(entry.crc ?? crc32(contents), 16);
  header.writeUInt32LE(contents.byteLength, 20);
  header.writeUInt32LE(entry.uncompressedSize ?? contents.byteLength, 24);
  header.writeUInt16LE(nameBytes.byteLength, 28);
  header.writeUInt32LE(offset, 42);
  return NodeBuffer.Buffer.concat([header, nameBytes]);
}

function crc32(contents: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function deflatedZipEntry(name: string, expanded: Uint8Array): ZipFixtureEntry {
  return {
    name,
    contents: NodeZlib.deflateRawSync(expanded),
    compressionMethod: 8,
    crc: crc32(expanded),
    uncompressedSize: expanded.byteLength,
  };
}

function zipFixture(entries: ReadonlyArray<ZipFixtureEntry>): NodeBuffer.Buffer {
  const localEntries: Array<NodeBuffer.Buffer> = [];
  const centralEntries: Array<NodeBuffer.Buffer> = [];
  let localOffset = 0;
  for (const entry of entries) {
    const local = zipLocalEntry(entry);
    localEntries.push(local);
    centralEntries.push(zipCentralEntry(entry, localOffset));
    localOffset += local.byteLength;
  }
  const centralDirectory = NodeBuffer.Buffer.concat(centralEntries);
  const end = NodeBuffer.Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  return NodeBuffer.Buffer.concat([...localEntries, centralDirectory, end]);
}

function docxFixture(): NodeBuffer.Buffer {
  const entries = [
    {
      name: "[Content_Types].xml",
      contents: NodeBuffer.Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "utf8",
      ),
    },
    {
      name: "_rels/.rels",
      contents: NodeBuffer.Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "utf8",
      ),
    },
    {
      name: "word/document.xml",
      contents: NodeBuffer.Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fixture</w:t></w:r></w:p></w:body></w:document>',
        "utf8",
      ),
    },
  ];
  return zipFixture(entries.map(({ name, contents }) => deflatedZipEntry(name, contents)));
}

function underdeclaredDeflateDocxFixture(): NodeBuffer.Buffer {
  const expanded = NodeBuffer.Buffer.alloc(1024 * 1024, 0x41);
  const compressed = NodeZlib.deflateRawSync(expanded);
  return zipFixture([
    {
      name: "[Content_Types].xml",
      contents: compressed,
      compressionMethod: 8,
      crc: crc32(expanded),
      uncompressedSize: 1,
    },
    {
      name: "word/document.xml",
      contents: NodeBuffer.Buffer.from("<w:document/>", "utf8"),
    },
  ]);
}

function compressionRatioBombDocxFixture(): NodeBuffer.Buffer {
  const bytes = docxFixture();
  const compressedSize = bytes.readUInt32LE(18);
  const uncompressedSize = compressedSize * (INTEGRATION_FILE_MAX_DOCX_COMPRESSION_RATIO + 1);
  const centralDirectoryOffset = bytes.readUInt32LE(bytes.byteLength - 6);
  bytes.writeUInt16LE(8, 8);
  bytes.writeUInt32LE(uncompressedSize, 22);
  bytes.writeUInt16LE(8, centralDirectoryOffset + 10);
  bytes.writeUInt32LE(compressedSize, centralDirectoryOffset + 20);
  bytes.writeUInt32LE(uncompressedSize, centralDirectoryOffset + 24);
  return bytes;
}

function largePdf(size: number, discriminator: number): NodeBuffer.Buffer {
  const bytes = NodeBuffer.Buffer.alloc(size, 0x20);
  PDF.copy(bytes, 0, 0, Math.min(PDF.byteLength, size));
  bytes[bytes.byteLength - 1] = discriminator;
  return bytes;
}

function resetFileSystemFailure(): void {
  fileSystemFailure.finalUnlinkPaths.clear();
  fileSystemFailure.failPublication = false;
  fileSystemFailure.removeBeforeOpenPath = null;
  fileSystemFailure.stagedPath = null;
  fileSystemFailure.unlinkPath = null;
}

async function makeFixture(prefix: string) {
  const parent = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  const root = NodePath.join(parent, "managed-integration-files");
  const materializer = new IntegrationFileMaterializer(root);
  await materializer.initialize();
  return { parent, root, materializer };
}

async function disposeFixture(fixture: Awaited<ReturnType<typeof makeFixture>>): Promise<void> {
  resetFileSystemFailure();
  await fixture.materializer.close().catch(() => undefined);
  await NodeFSP.rm(fixture.parent, { recursive: true, force: true });
}

function mode(value: { readonly mode: number }): number {
  return value.mode & 0o777;
}

describe("IntegrationFileMaterializer", () => {
  it("uses POSIX mode bits and Windows host ACLs without weakening identity checks", () => {
    const privateIdentity = {
      dev: 7,
      ino: 11,
      isFile: () => true,
      mode: 0o100_666,
      nlink: 1,
    };
    const expectedIdentity = { dev: 7, ino: 11 };
    expect(
      isPrivateIntegrationFileStat(privateIdentity, {
        expectedIdentity,
        expectedLinkCount: 1,
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      isPrivateIntegrationFileStat(privateIdentity, {
        expectedIdentity,
        expectedLinkCount: 1,
        platform: "win32",
      }),
    ).toBe(true);
    for (const changedIdentity of [
      { ...privateIdentity, isFile: () => false },
      { ...privateIdentity, nlink: 2 },
      { ...privateIdentity, ino: 12 },
    ]) {
      expect(
        isPrivateIntegrationFileStat(changedIdentity, {
          expectedIdentity,
          expectedLinkCount: 1,
          platform: "win32",
        }),
      ).toBe(false);
    }
  });

  it("materializes readable PDF, DOCX, and text files with generated private descriptors", async () => {
    const fixture = await makeFixture("tritonai-integration-files-valid-");
    try {
      const invocation = fixture.materializer.beginInvocation({
        threadId: "thread-valid",
        sessionId: "session-valid",
        signal: new AbortController().signal,
      });
      const hostileName = "../../project/remote-instructions.pdf";
      const pdf = await invocation.materializeFile(input(PDF, hostileName, "APPLICATION/PDF"));
      const docx = await invocation.materializeFile(
        input(docxFixture(), "report.docx", DOCX_MEDIA_TYPE),
      );
      const text = await invocation.materializeFile(input(TEXT, "notes.txt", "text/plain"));

      for (const [descriptor, contents] of [
        [pdf, PDF],
        [docx, docxFixture()],
        [text, TEXT],
      ] as const) {
        expect(NodePath.isAbsolute(descriptor.path)).toBe(true);
        expect(NodePath.dirname(descriptor.path)).toBe(fixture.root);
        expect(descriptor.name).toBe(NodePath.basename(descriptor.path));
        expect(descriptor.name.startsWith(INTEGRATION_FILE_RESERVED_PREFIX)).toBe(true);
        expect(descriptor.trust).toBe("untrusted");
        expect(await NodeFSP.readFile(descriptor.path)).toEqual(contents);
        expect(mode(await NodeFSP.stat(descriptor.path))).toBe(0o600);
      }
      expect(Object.keys(pdf).toSorted()).toEqual([
        "mediaType",
        "name",
        "path",
        "sizeBytes",
        "trust",
      ]);
      expect(JSON.stringify(pdf)).not.toContain(hostileName);
      expect(JSON.stringify(pdf)).not.toContain(PDF.toString("base64"));
      await invocation.commit();
      await expect(invocation.materializeFile(input())).rejects.toMatchObject({ code: "revoked" });
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("rejects malformed, encoded, empty, mismatched, and oversized inputs before allocation", async () => {
    const fixture = await makeFixture("tritonai-integration-files-invalid-");
    try {
      const invocation = fixture.materializer.beginInvocation({
        threadId: "thread-invalid",
        signal: new AbortController().signal,
      });
      const invalidInputs: ReadonlyArray<unknown> = [
        { bytes: TEXT.toString("base64"), name: "encoded.txt", mediaType: "text/plain" },
        { bytes: TEXT, name: "extra.txt", mediaType: "text/plain", targetPath: "/tmp/file" },
        input(new Uint8Array(), "empty.txt", "text/plain"),
        input(NodeBuffer.Buffer.from([0xff]), "invalid.txt", "text/plain"),
        input(PDF, "mismatch.txt", "text/plain"),
        input(
          NodeBuffer.Buffer.concat([NodeBuffer.Buffer.from("PK\u0003\u0004"), TEXT]),
          "fake.docx",
          DOCX_MEDIA_TYPE,
        ),
        input(
          NodeBuffer.Buffer.from(
            "PK\u0003\u0004 arbitrary [Content_Types].xml and word/document.xml markers",
            "utf8",
          ),
          "fake-markers.docx",
          DOCX_MEDIA_TYPE,
        ),
        input(compressionRatioBombDocxFixture(), "compressed-bomb.docx", DOCX_MEDIA_TYPE),
        input(underdeclaredDeflateDocxFixture(), "underdeclared.docx", DOCX_MEDIA_TYPE),
        input(TEXT, "x".repeat(INTEGRATION_FILE_MAX_NAME_BYTES + 1), "text/plain"),
        input(NodeBuffer.Buffer.alloc(INTEGRATION_FILE_MAX_BYTES + 1), "large.txt", "text/plain"),
      ];
      for (const candidate of invalidInputs) {
        await expect(
          invocation.materializeFile(candidate as IntegrationFileMaterializationInput),
        ).rejects.toBeInstanceOf(Error);
        expect(await NodeFSP.readdir(fixture.root)).toEqual([]);
      }
      await invocation.abort();
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("deduplicates by SHA-256 within a session and preserves a shared file on one abort", async () => {
    const fixture = await makeFixture("tritonai-integration-files-dedupe-");
    try {
      const first = fixture.materializer.beginInvocation({
        threadId: "thread-dedupe",
        sessionId: "session-dedupe",
        signal: new AbortController().signal,
      });
      const second = fixture.materializer.beginInvocation({
        threadId: "thread-dedupe",
        sessionId: "session-dedupe",
        signal: new AbortController().signal,
      });
      const firstDescriptor = await first.materializeFile(input(TEXT, "first.txt"));
      const secondDescriptor = await second.materializeFile(input(TEXT, "second.txt"));
      expect(secondDescriptor).toEqual(firstDescriptor);
      await first.abort();
      expect(await NodeFSP.readFile(secondDescriptor.path)).toEqual(TEXT);
      await second.commit();
      expect(await NodeFSP.readdir(NodePath.dirname(secondDescriptor.path))).toEqual([
        secondDescriptor.name,
      ]);
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("keeps the omitted session scope distinct from every explicit session identifier", async () => {
    const fixture = await makeFixture("tritonai-integration-files-default-session-");
    try {
      const omitted = fixture.materializer.beginInvocation({
        threadId: "thread-default-session",
        signal: new AbortController().signal,
      });
      const explicit = fixture.materializer.beginInvocation({
        threadId: "thread-default-session",
        sessionId: "\0default-session",
        signal: new AbortController().signal,
      });
      const omittedFile = await omitted.materializeFile(input());
      const explicitFile = await explicit.materializeFile(input());
      expect(explicitFile.path).not.toBe(omittedFile.path);
      await omitted.commit();
      await explicit.commit();

      await fixture.materializer.clearSession("thread-default-session");
      await expect(NodeFSP.stat(omittedFile.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.stat(explicitFile.path)).resolves.toBeDefined();
      await fixture.materializer.clearSession("thread-default-session", "\0default-session");
      await expect(NodeFSP.stat(explicitFile.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("serializes concurrent validation and cannot overshoot the session quota", async () => {
    const fixture = await makeFixture("tritonai-integration-files-concurrent-");
    try {
      const invocation = fixture.materializer.beginInvocation({
        threadId: "thread-concurrent",
        signal: new AbortController().signal,
      });
      const outcomes = await Promise.allSettled(
        Array.from({ length: INTEGRATION_FILE_MAX_UNIQUE_FILES_PER_SESSION + 4 }, (_, index) =>
          invocation.materializeFile(input(NodeBuffer.Buffer.from(`concurrent-${index}`, "utf8"))),
        ),
      );
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
        INTEGRATION_FILE_MAX_UNIQUE_FILES_PER_SESSION,
      );
      expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(4);
      await invocation.abort();
      expect(await NodeFSP.readdir(fixture.root)).toEqual([]);
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("enforces session and global unique-file quotas and releases accounting on cleanup", async () => {
    const fixture = await makeFixture("tritonai-integration-files-count-quota-");
    try {
      const committed: Array<ReturnType<typeof fixture.materializer.beginInvocation>> = [];
      const sessionCount =
        INTEGRATION_FILE_MAX_UNIQUE_FILES_GLOBAL / INTEGRATION_FILE_MAX_UNIQUE_FILES_PER_SESSION;
      for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
        const invocation = fixture.materializer.beginInvocation({
          threadId: "thread-global-count",
          sessionId: `session-${sessionIndex}`,
          signal: new AbortController().signal,
        });
        for (
          let fileIndex = 0;
          fileIndex < INTEGRATION_FILE_MAX_UNIQUE_FILES_PER_SESSION;
          fileIndex += 1
        ) {
          await invocation.materializeFile(
            input(
              NodeBuffer.Buffer.from(`record-${sessionIndex}-${fileIndex}`, "utf8"),
              "ignored.txt",
            ),
          );
        }
        await invocation.commit();
        committed.push(invocation);
      }
      const overGlobal = fixture.materializer.beginInvocation({
        threadId: "thread-global-count",
        sessionId: "over-global",
        signal: new AbortController().signal,
      });
      await expect(overGlobal.materializeFile(input())).rejects.toMatchObject({
        code: "quota_exceeded",
      });
      await overGlobal.abort();

      await fixture.materializer.clearSession("thread-global-count", "session-0");
      const afterRelease = fixture.materializer.beginInvocation({
        threadId: "thread-global-count",
        sessionId: "after-release",
        signal: new AbortController().signal,
      });
      await expect(afterRelease.materializeFile(input())).resolves.toMatchObject({
        trust: "untrusted",
      });
      await afterRelease.abort();
      await fixture.materializer.clearAll();
      expect(await NodeFSP.readdir(fixture.root)).toEqual([]);
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("enforces the global byte quota and releases it on thread cleanup", async () => {
    const fixture = await makeFixture("tritonai-integration-files-byte-quota-");
    try {
      let remaining = INTEGRATION_FILE_MAX_UNIQUE_BYTES_GLOBAL;
      let discriminator = 1;
      for (const sessionId of ["bytes-a", "bytes-b"]) {
        const invocation = fixture.materializer.beginInvocation({
          threadId: "thread-global-bytes",
          sessionId,
          signal: new AbortController().signal,
        });
        let sessionBytes = 0;
        while (remaining > 0 && sessionBytes < 20 * 1024 * 1024) {
          const size = Math.min(
            INTEGRATION_FILE_MAX_BYTES,
            remaining,
            20 * 1024 * 1024 - sessionBytes,
          );
          await invocation.materializeFile(
            input(largePdf(size, discriminator++), "large.pdf", "application/pdf"),
          );
          remaining -= size;
          sessionBytes += size;
        }
        await invocation.commit();
      }
      expect(remaining).toBe(0);
      const overGlobal = fixture.materializer.beginInvocation({
        threadId: "another-thread",
        signal: new AbortController().signal,
      });
      await expect(overGlobal.materializeFile(input())).rejects.toMatchObject({
        code: "quota_exceeded",
      });
      await overGlobal.abort();
      await fixture.materializer.clearThread("thread-global-bytes");

      const afterRelease = fixture.materializer.beginInvocation({
        threadId: "another-thread",
        signal: new AbortController().signal,
      });
      await expect(afterRelease.materializeFile(input())).resolves.toMatchObject({
        trust: "untrusted",
      });
      await afterRelease.abort();
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("never overwrites or follows collisions at a reserved final leaf", async () => {
    const fixture = await makeFixture("tritonai-integration-files-path-safety-");
    const externalSentinel = NodePath.join(fixture.parent, "external-sentinel.txt");
    try {
      await NodeFSP.writeFile(externalSentinel, "keep", { mode: 0o600 });
      const collisionThread = "thread-collision";
      const collisionSession = "session-collision";
      const collisionProbe = fixture.materializer.beginInvocation({
        threadId: collisionThread,
        sessionId: collisionSession,
        signal: new AbortController().signal,
      });
      const collisionPath = (await collisionProbe.materializeFile(input())).path;
      await collisionProbe.abort();
      await NodeFSP.writeFile(collisionPath, "existing", { mode: 0o600 });
      const collision = fixture.materializer.beginInvocation({
        threadId: collisionThread,
        sessionId: collisionSession,
        signal: new AbortController().signal,
      });
      await expect(collision.materializeFile(input())).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      expect(await NodeFSP.readFile(collisionPath, "utf8")).toBe("existing");
      await collision.abort();

      if (NodeProcess.platform !== "win32") {
        const symlinkThread = "thread-symlink";
        const symlinkSession = "session-symlink";
        const symlinkProbe = fixture.materializer.beginInvocation({
          threadId: symlinkThread,
          sessionId: symlinkSession,
          signal: new AbortController().signal,
        });
        const symlinkPath = (await symlinkProbe.materializeFile(input())).path;
        await symlinkProbe.abort();
        await NodeFSP.symlink(externalSentinel, symlinkPath, "file");
        const symlinked = fixture.materializer.beginInvocation({
          threadId: symlinkThread,
          sessionId: symlinkSession,
          signal: new AbortController().signal,
        });
        await expect(symlinked.materializeFile(input())).rejects.toMatchObject({
          code: "storage_unavailable",
        });
        expect(await NodeFSP.readFile(externalSentinel, "utf8")).toBe("keep");
        expect((await NodeFSP.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
        await symlinked.abort();
      }
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("rolls back aborted invocations and rejects commit after signal or session revocation", async () => {
    const fixture = await makeFixture("tritonai-integration-files-revocation-");
    try {
      const controller = new AbortController();
      const cancelled = fixture.materializer.beginInvocation({
        threadId: "thread-revoked",
        sessionId: "session-revoked",
        signal: controller.signal,
      });
      const cancelledFile = await cancelled.materializeFile(input());
      controller.abort(new Error("cancelled"));
      await expect(cancelled.commit()).rejects.toMatchObject({ code: "revoked" });
      await expect(NodeFSP.stat(cancelledFile.path)).rejects.toMatchObject({ code: "ENOENT" });

      const cleared = fixture.materializer.beginInvocation({
        threadId: "thread-revoked",
        sessionId: "session-revoked",
        signal: new AbortController().signal,
      });
      const clearedFile = await cleared.materializeFile(
        input(PDF, "remote.pdf", "application/pdf"),
      );
      const cleanup = fixture.materializer.clearSession("thread-revoked", "session-revoked");
      await expect(cleared.materializeFile(input())).rejects.toMatchObject({ code: "revoked" });
      await cleanup;
      await expect(cleared.commit()).rejects.toMatchObject({ code: "revoked" });
      await expect(NodeFSP.stat(clearedFile.path)).rejects.toMatchObject({ code: "ENOENT" });

      const newEpoch = fixture.materializer.beginInvocation({
        threadId: "thread-revoked",
        sessionId: "session-revoked",
        signal: new AbortController().signal,
      });
      await expect(newEpoch.materializeFile(input())).resolves.toMatchObject({
        trust: "untrusted",
      });
      await newEpoch.abort();
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("retains quota accounting when rollback cannot unlink a materialized file", async () => {
    const fixture = await makeFixture("tritonai-integration-files-unlink-failure-");
    try {
      const invocation = fixture.materializer.beginInvocation({
        threadId: "thread-unlink-failure",
        sessionId: "session-unlink-failure",
        signal: new AbortController().signal,
      });
      for (let index = 0; index < INTEGRATION_FILE_MAX_UNIQUE_FILES_PER_SESSION; index += 1) {
        const descriptor = await invocation.materializeFile(
          input(NodeBuffer.Buffer.from(`retained-${index}`, "utf8")),
        );
        fileSystemFailure.finalUnlinkPaths.add(descriptor.path);
      }
      await expect(invocation.abort()).rejects.toMatchObject({ code: "storage_unavailable" });
      fileSystemFailure.finalUnlinkPaths.clear();

      const afterFailure = fixture.materializer.beginInvocation({
        threadId: "thread-unlink-failure",
        sessionId: "session-unlink-failure",
        signal: new AbortController().signal,
      });
      await expect(
        afterFailure.materializeFile(input(NodeBuffer.Buffer.from("one-more", "utf8"))),
      ).rejects.toMatchObject({ code: "quota_exceeded" });
      await afterFailure.abort();
      await fixture.materializer.clearSession("thread-unlink-failure", "session-unlink-failure");

      const afterCleanup = fixture.materializer.beginInvocation({
        threadId: "thread-unlink-failure",
        sessionId: "session-unlink-failure",
        signal: new AbortController().signal,
      });
      await expect(afterCleanup.materializeFile(input())).resolves.toMatchObject({
        trust: "untrusted",
      });
      await afterCleanup.abort();
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("retains session accounting when scoped cleanup cannot remove a tracked leaf", async () => {
    const fixture = await makeFixture("tritonai-integration-files-clear-failure-");
    try {
      const invocation = fixture.materializer.beginInvocation({
        threadId: "thread-clear-failure",
        sessionId: "session-clear-failure",
        signal: new AbortController().signal,
      });
      for (let index = 0; index < INTEGRATION_FILE_MAX_UNIQUE_FILES_PER_SESSION; index += 1) {
        const descriptor = await invocation.materializeFile(
          input(NodeBuffer.Buffer.from(`committed-${index}`, "utf8")),
        );
        fileSystemFailure.finalUnlinkPaths.add(descriptor.path);
      }
      await invocation.commit();
      await expect(
        fixture.materializer.clearSession("thread-clear-failure", "session-clear-failure"),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      fileSystemFailure.finalUnlinkPaths.clear();

      const afterFailure = fixture.materializer.beginInvocation({
        threadId: "thread-clear-failure",
        sessionId: "session-clear-failure",
        signal: new AbortController().signal,
      });
      await expect(
        afterFailure.materializeFile(input(NodeBuffer.Buffer.from("one-more", "utf8"))),
      ).rejects.toMatchObject({ code: "quota_exceeded" });
      await afterFailure.abort();
      await fixture.materializer.clearSession("thread-clear-failure", "session-clear-failure");
      expect(await NodeFSP.readdir(fixture.root)).toEqual([]);
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("retains accounting when a tracked leaf disappears between identity checks", async () => {
    const fixture = await makeFixture("tritonai-integration-files-disappearance-race-");
    try {
      const invocation = fixture.materializer.beginInvocation({
        threadId: "thread-disappearance-race",
        sessionId: "session-disappearance-race",
        signal: new AbortController().signal,
      });
      let racedPath = "";
      for (let index = 0; index < INTEGRATION_FILE_MAX_UNIQUE_FILES_PER_SESSION; index += 1) {
        const descriptor = await invocation.materializeFile(
          input(NodeBuffer.Buffer.from(`raced-${index}`, "utf8")),
        );
        racedPath ||= descriptor.path;
      }
      await invocation.commit();
      fileSystemFailure.removeBeforeOpenPath = racedPath;
      await expect(
        fixture.materializer.clearSession(
          "thread-disappearance-race",
          "session-disappearance-race",
        ),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(NodeFSP.stat(racedPath)).rejects.toMatchObject({ code: "ENOENT" });

      const retained = fixture.materializer.beginInvocation({
        threadId: "thread-disappearance-race",
        sessionId: "session-disappearance-race",
        signal: new AbortController().signal,
      });
      await expect(
        retained.materializeFile(input(NodeBuffer.Buffer.from("one-more", "utf8"))),
      ).rejects.toMatchObject({ code: "quota_exceeded" });
      await retained.abort();
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("fails closed when publication rollback leaves a staged reserved leaf", async () => {
    const fixture = await makeFixture("tritonai-integration-files-publication-failure-");
    try {
      const invocation = fixture.materializer.beginInvocation({
        threadId: "thread-publication-failure",
        signal: new AbortController().signal,
      });
      fileSystemFailure.failPublication = true;
      await expect(invocation.materializeFile(input())).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      expect(fileSystemFailure.stagedPath).not.toBeNull();
      await expect(NodeFSP.stat(fileSystemFailure.stagedPath!)).resolves.toBeDefined();
      fileSystemFailure.failPublication = false;

      expect(() =>
        fixture.materializer.beginInvocation({
          threadId: "thread-after-publication-failure",
          signal: new AbortController().signal,
        }),
      ).toThrow(expect.objectContaining({ code: "storage_unavailable" }));
      await fixture.materializer.clearAll();
      await expect(NodeFSP.stat(fileSystemFailure.stagedPath!)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const recovered = fixture.materializer.beginInvocation({
        threadId: "thread-after-publication-failure",
        signal: new AbortController().signal,
      });
      await expect(recovered.materializeFile(input())).resolves.toMatchObject({
        trust: "untrusted",
      });
      await recovered.abort();
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("retains tracked identity and accounting when a final leaf is replaced", async () => {
    if (NodeProcess.platform === "win32") return;
    const fixture = await makeFixture("tritonai-integration-files-tracked-tamper-");
    const external = NodePath.join(fixture.parent, "external.txt");
    try {
      await NodeFSP.writeFile(external, "external-preserve");
      const commitFile = async (threadId: string, sessionId: string) => {
        const invocation = fixture.materializer.beginInvocation({
          threadId,
          sessionId,
          signal: new AbortController().signal,
        });
        const descriptor = await invocation.materializeFile(input());
        await invocation.commit();
        return descriptor;
      };
      const sessionFile = await commitFile("thread-tamper", "session-tamper");
      const sessionBackup = NodePath.join(fixture.parent, "session-original.txt");
      await NodeFSP.rename(sessionFile.path, sessionBackup);
      // Point the symlink back to the original inode. An fd-only check would accept this on a
      // platform where O_NOFOLLOW is unavailable; pathname lstat must still reject it.
      await NodeFSP.symlink(sessionBackup, sessionFile.path, "file");
      await expect(
        fixture.materializer.clearSession("thread-tamper", "session-tamper"),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      expect((await NodeFSP.lstat(sessionFile.path)).isSymbolicLink()).toBe(true);
      expect(await NodeFSP.readFile(sessionBackup)).toEqual(TEXT);
      expect(await NodeFSP.readFile(external, "utf8")).toBe("external-preserve");
      const retained = fixture.materializer.beginInvocation({
        threadId: "thread-tamper",
        sessionId: "session-tamper",
        signal: new AbortController().signal,
      });
      await expect(retained.materializeFile(input())).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await retained.abort();
      await NodeFSP.unlink(sessionFile.path);
      await NodeFSP.rename(sessionBackup, sessionFile.path);
      await fixture.materializer.clearSession("thread-tamper", "session-tamper");

      const globalFile = await commitFile("thread-global-tamper", "session-global-tamper");
      const globalBackup = NodePath.join(fixture.parent, "global-original.txt");
      await NodeFSP.rename(globalFile.path, globalBackup);
      await NodeFSP.symlink(external, globalFile.path, "file");
      await expect(fixture.materializer.clearAll()).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      expect((await NodeFSP.lstat(globalFile.path)).isSymbolicLink()).toBe(true);
      expect(await NodeFSP.readFile(globalBackup)).toEqual(TEXT);
      expect(await NodeFSP.readFile(external, "utf8")).toBe("external-preserve");
      await NodeFSP.unlink(globalFile.path);
      await NodeFSP.rename(globalBackup, globalFile.path);
      await fixture.materializer.clearAll();

      const hardlinkFile = await commitFile("thread-hardlink", "session-hardlink");
      const extraLink = NodePath.join(fixture.parent, "extra-hardlink.txt");
      await NodeFSP.link(hardlinkFile.path, extraLink);
      const hardlinkRetained = fixture.materializer.beginInvocation({
        threadId: "thread-hardlink",
        sessionId: "session-hardlink",
        signal: new AbortController().signal,
      });
      await expect(hardlinkRetained.materializeFile(input())).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await hardlinkRetained.abort();
      await expect(
        fixture.materializer.clearSession("thread-hardlink", "session-hardlink"),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      expect((await NodeFSP.stat(hardlinkFile.path)).nlink).toBe(2);
      expect(await NodeFSP.readFile(extraLink)).toEqual(TEXT);
      await NodeFSP.unlink(extraLink);
      await fixture.materializer.clearSession("thread-hardlink", "session-hardlink");
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("cleans exact session, thread, startup, clear-all, and shutdown scopes", async () => {
    const parent = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-integration-files-lifecycle-"),
    );
    const root = NodePath.join(parent, "managed-integration-files");
    const unrelated = NodePath.join(root, "user-owned.txt");
    const unrelatedStale = NodePath.join(root, "stale.tmp");
    const staleReserved = NodePath.join(root, `${INTEGRATION_FILE_RESERVED_PREFIX}stale`);
    const external = NodePath.join(parent, "external-user-owned.txt");
    await NodeFSP.mkdir(root, { mode: 0o755 });
    await NodeFSP.writeFile(unrelated, "preserve");
    await NodeFSP.writeFile(unrelatedStale, "unrelated");
    await NodeFSP.writeFile(staleReserved, "owned-stale");
    await NodeFSP.writeFile(external, "external-preserve");
    if (NodeProcess.platform !== "win32") {
      await NodeFSP.symlink(
        external,
        NodePath.join(root, `${INTEGRATION_FILE_RESERVED_PREFIX}stale-link`),
        "file",
      );
    }
    const materializer = new IntegrationFileMaterializer(root);
    try {
      await materializer.initialize();
      expect((await NodeFSP.readdir(root)).toSorted()).toEqual(["stale.tmp", "user-owned.txt"]);
      expect(mode(await NodeFSP.stat(root))).toBe(0o755);
      expect(await NodeFSP.readFile(external, "utf8")).toBe("external-preserve");
      const descriptors = new Map<string, string>();
      for (const [threadId, sessionId] of [
        ["thread-a", undefined],
        ["thread-a", "session-two"],
        ["thread-b", "session-three"],
      ] as const) {
        const invocation = materializer.beginInvocation({
          threadId,
          ...(sessionId === undefined ? {} : { sessionId }),
          signal: new AbortController().signal,
        });
        const descriptor = await invocation.materializeFile(
          input(NodeBuffer.Buffer.from(`${threadId}/${sessionId ?? "default"}`, "utf8")),
        );
        await invocation.commit();
        descriptors.set(`${threadId}/${sessionId ?? "default"}`, descriptor.path);
      }
      await materializer.clearSession("thread-a", "session-two");
      await expect(NodeFSP.stat(descriptors.get("thread-a/session-two")!)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(NodeFSP.stat(descriptors.get("thread-a/default")!)).resolves.toBeDefined();
      await materializer.clearThread("thread-a");
      await expect(NodeFSP.stat(descriptors.get("thread-a/default")!)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(NodeFSP.stat(descriptors.get("thread-b/session-three")!)).resolves.toBeDefined();

      const cleaning = materializer.clearThread("thread-b");
      expect(() =>
        materializer.beginInvocation({
          threadId: "unrelated-thread",
          signal: new AbortController().signal,
        }),
      ).toThrow();
      await cleaning;
      const afterCleanup = materializer.beginInvocation({
        threadId: "unrelated-thread",
        signal: new AbortController().signal,
      });
      const clearAllFile = await afterCleanup.materializeFile(input());
      await afterCleanup.commit();
      await materializer.clearAll();
      await expect(NodeFSP.stat(clearAllFile.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await NodeFSP.readdir(root)).toSorted()).toEqual(["stale.tmp", "user-owned.txt"]);

      const shutdown = materializer.beginInvocation({
        threadId: "shutdown-thread",
        signal: new AbortController().signal,
      });
      const shutdownFile = await shutdown.materializeFile(
        input(PDF, "shutdown.pdf", "application/pdf"),
      );
      await shutdown.commit();
      await materializer.close();
      await expect(NodeFSP.stat(shutdownFile.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(NodeFSP.stat(root)).resolves.toBeDefined();
      expect(mode(await NodeFSP.stat(root))).toBe(0o755);
      expect(await NodeFSP.readFile(unrelated, "utf8")).toBe("preserve");
      expect(await NodeFSP.readFile(unrelatedStale, "utf8")).toBe("unrelated");
    } finally {
      await materializer.close().catch(() => undefined);
      await NodeFSP.rm(parent, { recursive: true, force: true });
    }
  });

  it("fails closed on a reserved directory without touching any shared-root entry", async () => {
    const parent = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-integration-files-reserved-directory-"),
    );
    const root = NodePath.join(parent, "attachments");
    const unrelated = NodePath.join(root, "user-owned.txt");
    const reservedFile = NodePath.join(root, `${INTEGRATION_FILE_RESERVED_PREFIX}stale-file`);
    const reservedDirectory = NodePath.join(root, `${INTEGRATION_FILE_RESERVED_PREFIX}blocked`);
    const nested = NodePath.join(reservedDirectory, "sentinel.txt");
    try {
      await NodeFSP.mkdir(reservedDirectory, { recursive: true });
      await NodeFSP.writeFile(unrelated, "preserve");
      await NodeFSP.writeFile(reservedFile, "preserve-until-validation-completes");
      await NodeFSP.writeFile(nested, "never-recursively-remove");
      const materializer = new IntegrationFileMaterializer(root);
      await expect(materializer.initialize()).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      expect(await NodeFSP.readFile(unrelated, "utf8")).toBe("preserve");
      expect(await NodeFSP.readFile(reservedFile, "utf8")).toBe(
        "preserve-until-validation-completes",
      );
      expect(await NodeFSP.readFile(nested, "utf8")).toBe("never-recursively-remove");
    } finally {
      await NodeFSP.rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked startup root without touching its target", async () => {
    if (NodeProcess.platform === "win32") return;
    const parent = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "tritonai-integration-files-root-symlink-"),
    );
    const external = NodePath.join(parent, "external");
    const root = NodePath.join(parent, "managed-integration-files");
    try {
      await NodeFSP.mkdir(external);
      await NodeFSP.writeFile(NodePath.join(external, "sentinel.txt"), "preserve");
      await NodeFSP.symlink(external, root, "dir");
      const materializer = new IntegrationFileMaterializer(root);
      await expect(materializer.initialize()).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      expect(await NodeFSP.readFile(NodePath.join(external, "sentinel.txt"), "utf8")).toBe(
        "preserve",
      );
    } finally {
      await NodeFSP.rm(parent, { recursive: true, force: true });
    }
  });

  it("fails closed if the managed root is swapped after initialization", async () => {
    if (NodeProcess.platform === "win32") return;
    const fixture = await makeFixture("tritonai-integration-files-root-swap-");
    const ownedRoot = `${fixture.root}.owned`;
    const external = NodePath.join(fixture.parent, "external-runtime-target");
    const sentinel = NodePath.join(external, "sentinel.txt");
    try {
      await NodeFSP.mkdir(external, { mode: 0o700 });
      await NodeFSP.writeFile(sentinel, "preserve", { mode: 0o600 });
      await NodeFSP.rename(fixture.root, ownedRoot);
      await NodeFSP.symlink(external, fixture.root, "dir");
      await expect(fixture.materializer.clearAll()).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      expect(await NodeFSP.readFile(sentinel, "utf8")).toBe("preserve");
      expect(await NodeFSP.readdir(external)).toEqual(["sentinel.txt"]);

      await NodeFSP.unlink(fixture.root);
      await NodeFSP.rename(ownedRoot, fixture.root);
      await fixture.materializer.clearAll();
    } finally {
      const rootEntry = await NodeFSP.lstat(fixture.root).catch(() => null);
      if (rootEntry?.isSymbolicLink()) await NodeFSP.unlink(fixture.root);
      const ownedEntry = await NodeFSP.lstat(ownedRoot).catch(() => null);
      if (ownedEntry) await NodeFSP.rename(ownedRoot, fixture.root);
      await disposeFixture(fixture);
    }
  });
});
