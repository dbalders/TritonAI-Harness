// The materializer deliberately owns its Node filesystem boundary instead of exposing paths or
// write primitives to integration providers.
// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeZlib from "node:zlib";

export const INTEGRATION_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const INTEGRATION_FILE_MAX_NAME_BYTES = 255;
export const INTEGRATION_FILE_MAX_MEDIA_TYPE_BYTES = 128;
export const INTEGRATION_FILE_MAX_SCOPE_ID_BYTES = 1_024;
export const INTEGRATION_FILE_MAX_UNIQUE_FILES_PER_SESSION = 16;
export const INTEGRATION_FILE_MAX_UNIQUE_BYTES_PER_SESSION = 20 * 1024 * 1024;
export const INTEGRATION_FILE_MAX_UNIQUE_FILES_GLOBAL = 64;
export const INTEGRATION_FILE_MAX_UNIQUE_BYTES_GLOBAL = 32 * 1024 * 1024;
export const INTEGRATION_FILE_MAX_DOCX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
export const INTEGRATION_FILE_MAX_DOCX_COMPRESSION_RATIO = 100;
export const INTEGRATION_FILE_RESERVED_PREFIX = ".integration-file.";

export interface IntegrationFileMaterializationInput {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly mediaType: string;
}

export interface IntegrationFileDescriptor {
  readonly path: string;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly trust: "untrusted";
}

export type IntegrationMaterializeFile = (
  input: IntegrationFileMaterializationInput,
) => Promise<IntegrationFileDescriptor>;

export interface IntegrationFileInvocation {
  readonly materializeFile: IntegrationMaterializeFile;
  readonly commit: () => Promise<void>;
  readonly abort: () => Promise<void>;
}

export type IntegrationFileMaterializationErrorCode =
  | "invalid_input"
  | "unsupported_file"
  | "quota_exceeded"
  | "revoked"
  | "storage_unavailable";

export class IntegrationFileMaterializationError extends Error {
  readonly code: IntegrationFileMaterializationErrorCode;

  constructor(
    code: IntegrationFileMaterializationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IntegrationFileMaterializationError";
    this.code = code;
  }
}

interface ValidatedFile {
  readonly bytes: NodeBuffer.Buffer;
  readonly digest: string;
  readonly extension: ".docx" | ".pdf" | ".txt";
  readonly mediaType:
    | "application/pdf"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "text/plain";
}

interface MaterializedFileRecord {
  readonly digest: string;
  readonly descriptor: IntegrationFileDescriptor;
  readonly device: number;
  readonly inode: number;
  readonly pendingInvocationIds: Set<number>;
  committed: boolean;
}

interface SessionState {
  readonly key: string;
  readonly threadToken: string;
  readonly sessionToken: string;
  readonly epoch: number;
  readonly storageToken: string;
  readonly files: Map<string, MaterializedFileRecord>;
  totalBytes: number;
}

interface InvocationLease {
  readonly id: number;
  readonly session: SessionState;
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly digests: Set<string>;
  revoked: boolean;
  settlement: "active" | "committed" | "aborted";
  settlementPromise: Promise<void> | null;
  removeAbortListener: () => void;
}

const PDF_MEDIA_TYPE = "application/pdf";
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TEXT_MEDIA_TYPE = "text/plain";
const DOCX_CONTENT_TYPES_ENTRY = NodeBuffer.Buffer.from("[Content_Types].xml", "utf8");
const DOCX_DOCUMENT_ENTRY = NodeBuffer.Buffer.from("word/document.xml", "utf8");
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const DOCX_MAX_LOCAL_FILE_HEADERS = 4_096;
const DOCX_MAX_ENTRY_NAME_BYTES = 4_096;

interface ZipEntryMetadata {
  readonly name: NodeBuffer.Buffer;
  readonly flags: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}
const INPUT_KEYS = new Set(["bytes", "mediaType", "name"]);
const OPEN_TEMP_FLAGS =
  NodeFS.constants.O_WRONLY |
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_EXCL |
  (NodeFS.constants.O_NOFOLLOW ?? 0);
const OPEN_READ_FLAGS = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0);

function materializationError(
  code: IntegrationFileMaterializationErrorCode,
  message: string,
  cause?: unknown,
): IntegrationFileMaterializationError {
  return new IntegrationFileMaterializationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function storageError(cause: unknown): IntegrationFileMaterializationError {
  return materializationError(
    "storage_unavailable",
    "Harness could not safely materialize the integration file.",
    cause,
  );
}

function revokedError(cause?: unknown): IntegrationFileMaterializationError {
  return materializationError(
    "revoked",
    "The integration file materialization lease is no longer active.",
    cause,
  );
}

function byteLength(value: string): number {
  return NodeBuffer.Buffer.byteLength(value, "utf8");
}

function sha256(value: string | Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function scopeToken(domain: "default-session" | "session" | "thread", value: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const encoded = NodeBuffer.Buffer.from(value, "utf8");
  const length = NodeBuffer.Buffer.allocUnsafe(4);
  length.writeUInt32BE(encoded.byteLength);
  hash.update(domain);
  hash.update(NodeBuffer.Buffer.from([0]));
  hash.update(length);
  hash.update(encoded);
  return hash.digest("hex");
}

function validateScopeId(value: unknown, label: "sessionId" | "threadId"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > INTEGRATION_FILE_MAX_SCOPE_ID_BYTES
  ) {
    throw materializationError("invalid_input", `${label} must be a bounded non-empty string.`);
  }
  return value;
}

function startsWith(bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function hasRequiredDocxEntries(bytes: NodeBuffer.Buffer): boolean {
  let offset = 0;
  let localHeaderCount = 0;
  let totalUncompressedBytes = 0;
  let hasContentTypes = false;
  let hasDocument = false;
  const localEntries = new Map<number, ZipEntryMetadata>();
  while (offset + 4 <= bytes.byteLength) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === ZIP_CENTRAL_DIRECTORY_HEADER) {
      break;
    }
    if (
      signature !== ZIP_LOCAL_FILE_HEADER ||
      offset + 30 > bytes.byteLength ||
      ++localHeaderCount > DOCX_MAX_LOCAL_FILE_HEADERS
    ) {
      return false;
    }
    const flags = bytes.readUInt16LE(offset + 6);
    const compressionMethod = bytes.readUInt16LE(offset + 8);
    const crc32 = bytes.readUInt32LE(offset + 14);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    // Encrypted and data-descriptor entries cannot be bounded from their local header alone.
    if (
      (flags & 0x0001) !== 0 ||
      (flags & 0x0008) !== 0 ||
      (compressionMethod !== 0 && compressionMethod !== 8) ||
      (compressionMethod === 0 && compressedSize !== uncompressedSize) ||
      nameLength === 0 ||
      nameLength > DOCX_MAX_ENTRY_NAME_BYTES ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      (uncompressedSize > 0 && compressedSize === 0) ||
      uncompressedSize > compressedSize * INTEGRATION_FILE_MAX_DOCX_COMPRESSION_RATIO ||
      uncompressedSize > INTEGRATION_FILE_MAX_DOCX_UNCOMPRESSED_BYTES ||
      totalUncompressedBytes + uncompressedSize > INTEGRATION_FILE_MAX_DOCX_UNCOMPRESSED_BYTES
    ) {
      return false;
    }
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const nextOffset = contentStart + compressedSize;
    if (contentStart > bytes.byteLength || nextOffset > bytes.byteLength) return false;
    if (compressionMethod === 8) {
      const remainingBytes = INTEGRATION_FILE_MAX_DOCX_UNCOMPRESSED_BYTES - totalUncompressedBytes;
      // Bound inflate by both the declared entry length and the aggregate remaining budget. A
      // minimum ceiling of one lets a legitimately empty stream be checked without making zero
      // mean "unlimited" to the zlib binding.
      const maxOutputLength = Math.max(1, Math.min(uncompressedSize, remainingBytes));
      try {
        const inflated = NodeZlib.inflateRawSync(bytes.subarray(contentStart, nextOffset), {
          maxOutputLength,
        });
        if (inflated.byteLength !== uncompressedSize) return false;
      } catch {
        return false;
      }
    }
    const name = bytes.subarray(nameStart, nameStart + nameLength);
    totalUncompressedBytes += uncompressedSize;
    localEntries.set(offset, {
      name,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
    });
    if (name.equals(DOCX_CONTENT_TYPES_ENTRY)) hasContentTypes = true;
    if (name.equals(DOCX_DOCUMENT_ENTRY)) hasDocument = true;
    offset = nextOffset;
  }
  const centralDirectoryOffset = offset;
  let centralHeaderCount = 0;
  let centralHasContentTypes = false;
  let centralHasDocument = false;
  const seenLocalOffsets = new Set<number>();
  while (offset + 4 <= bytes.byteLength) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === ZIP_END_OF_CENTRAL_DIRECTORY) {
      if (offset + 22 > bytes.byteLength) return false;
      const diskNumber = bytes.readUInt16LE(offset + 4);
      const centralDirectoryDisk = bytes.readUInt16LE(offset + 6);
      const entriesOnDisk = bytes.readUInt16LE(offset + 8);
      const totalEntries = bytes.readUInt16LE(offset + 10);
      const centralDirectorySize = bytes.readUInt32LE(offset + 12);
      const recordedCentralOffset = bytes.readUInt32LE(offset + 16);
      const commentLength = bytes.readUInt16LE(offset + 20);
      return (
        hasContentTypes &&
        hasDocument &&
        centralHasContentTypes &&
        centralHasDocument &&
        diskNumber === 0 &&
        centralDirectoryDisk === 0 &&
        entriesOnDisk === localHeaderCount &&
        totalEntries === localHeaderCount &&
        centralHeaderCount === localHeaderCount &&
        centralDirectorySize === offset - centralDirectoryOffset &&
        recordedCentralOffset === centralDirectoryOffset &&
        offset + 22 + commentLength === bytes.byteLength
      );
    }
    if (
      signature !== ZIP_CENTRAL_DIRECTORY_HEADER ||
      offset + 46 > bytes.byteLength ||
      ++centralHeaderCount > DOCX_MAX_LOCAL_FILE_HEADERS
    ) {
      return false;
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    if (nameLength === 0 || nameLength > DOCX_MAX_ENTRY_NAME_BYTES) return false;
    const nameStart = offset + 46;
    const nextOffset = nameStart + nameLength + extraLength + commentLength;
    if (nextOffset > bytes.byteLength) return false;
    const name = bytes.subarray(nameStart, nameStart + nameLength);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const local = localEntries.get(localHeaderOffset);
    if (
      !local ||
      seenLocalOffsets.has(localHeaderOffset) ||
      !name.equals(local.name) ||
      bytes.readUInt16LE(offset + 8) !== local.flags ||
      bytes.readUInt16LE(offset + 10) !== local.compressionMethod ||
      bytes.readUInt32LE(offset + 16) !== local.crc32 ||
      bytes.readUInt32LE(offset + 20) !== local.compressedSize ||
      bytes.readUInt32LE(offset + 24) !== local.uncompressedSize
    ) {
      return false;
    }
    seenLocalOffsets.add(localHeaderOffset);
    if (name.equals(DOCX_CONTENT_TYPES_ENTRY)) centralHasContentTypes = true;
    if (name.equals(DOCX_DOCUMENT_ENTRY)) centralHasDocument = true;
    offset = nextOffset;
  }
  return false;
}

function validatedInput(input: unknown): ValidatedFile {
  let ownKeys: ReadonlyArray<PropertyKey>;
  try {
    ownKeys = Reflect.ownKeys(input as object);
  } catch (cause) {
    throw materializationError(
      "invalid_input",
      "Integration files require bytes, name, and mediaType fields.",
      cause,
    );
  }
  if (
    input === null ||
    typeof input !== "object" ||
    ownKeys.length !== INPUT_KEYS.size ||
    ownKeys.some((key) => typeof key !== "string" || !INPUT_KEYS.has(key))
  ) {
    throw materializationError(
      "invalid_input",
      "Integration files require only bytes, name, and mediaType fields.",
    );
  }

  const fields = Object.getOwnPropertyDescriptors(input);
  const bytesValue = fields.bytes?.value;
  const nameValue = fields.name?.value;
  const mediaTypeValue = fields.mediaType?.value;
  if (
    !(bytesValue instanceof Uint8Array) ||
    typeof nameValue !== "string" ||
    typeof mediaTypeValue !== "string"
  ) {
    throw materializationError(
      "invalid_input",
      "Integration files require Uint8Array bytes and string metadata.",
    );
  }
  if (byteLength(nameValue) > INTEGRATION_FILE_MAX_NAME_BYTES) {
    throw materializationError("invalid_input", "Integration file name metadata is too large.");
  }
  if (
    mediaTypeValue.length === 0 ||
    byteLength(mediaTypeValue) > INTEGRATION_FILE_MAX_MEDIA_TYPE_BYTES
  ) {
    throw materializationError("invalid_input", "Integration file media type metadata is invalid.");
  }

  let bytes: NodeBuffer.Buffer;
  try {
    if (bytesValue.byteLength > INTEGRATION_FILE_MAX_BYTES) {
      throw materializationError("quota_exceeded", "Integration file exceeds the 5 MiB limit.");
    }
    bytes = NodeBuffer.Buffer.from(bytesValue);
  } catch (cause) {
    if (cause instanceof IntegrationFileMaterializationError) throw cause;
    throw materializationError("invalid_input", "Integration file bytes are invalid.", cause);
  }
  if (bytes.byteLength > INTEGRATION_FILE_MAX_BYTES) {
    throw materializationError("quota_exceeded", "Integration file exceeds the 5 MiB limit.");
  }

  const mediaType = mediaTypeValue.trim().toLowerCase();
  const pdf = startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  const zip = startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  let kind: Omit<ValidatedFile, "bytes" | "digest">;
  if (bytes.byteLength === 0) {
    throw materializationError("unsupported_file", "Integration files cannot be empty.");
  }
  if (mediaType === PDF_MEDIA_TYPE && pdf) {
    kind = { extension: ".pdf", mediaType: PDF_MEDIA_TYPE };
  } else if (mediaType === DOCX_MEDIA_TYPE && zip && hasRequiredDocxEntries(bytes)) {
    kind = { extension: ".docx", mediaType: DOCX_MEDIA_TYPE };
  } else if (mediaType === TEXT_MEDIA_TYPE && !pdf && !zip && NodeBuffer.isUtf8(bytes)) {
    kind = { extension: ".txt", mediaType: TEXT_MEDIA_TYPE };
  } else {
    throw materializationError(
      "unsupported_file",
      "Integration files must be a PDF, DOCX, or UTF-8 plain text file with matching metadata.",
    );
  }

  return { bytes, digest: sha256(bytes), ...kind };
}

async function lstatOrNull(path: string): Promise<NodeFS.Stats | null> {
  try {
    return await NodeFSP.lstat(path, { bigint: false });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

function sameFile(
  left: Pick<NodeFS.Stats, "dev" | "ino">,
  right: Pick<NodeFS.Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Windows privacy comes from the host-owned user-profile/state attachment directory ACL rather
 * than portable Unix mode bits. On every platform, regular-file type, inode identity, and exact
 * native link count remain mandatory so a replacement or additional hard link fails closed.
 */
export function isPrivateIntegrationFileStat(
  stats: Pick<NodeFS.Stats, "dev" | "ino" | "mode" | "nlink"> & {
    readonly isFile: () => boolean;
  },
  options: {
    readonly expectedIdentity?: Pick<NodeFS.Stats, "dev" | "ino">;
    readonly expectedLinkCount: 1 | 2;
    readonly platform?: NodeJS.Platform;
  },
): boolean {
  return (
    stats.isFile() &&
    stats.nlink === options.expectedLinkCount &&
    (options.expectedIdentity === undefined || sameFile(stats, options.expectedIdentity)) &&
    ((options.platform ?? NodeProcess.platform) === "win32" || (stats.mode & 0o777) === 0o600)
  );
}

/**
 * Owns a flat reserved namespace within a host-managed directory. The supplied root may also
 * contain user-owned attachments: only reserved-prefix leaves belong to this cache, and provider
 * metadata never participates in any filesystem path.
 */
export class IntegrationFileMaterializer {
  readonly #root: string;
  readonly #sessions = new Map<string, SessionState>();
  readonly #leases = new Set<InvocationLease>();
  #operation: Promise<void> = Promise.resolve();
  #initialized = false;
  #closed = false;
  #rootIdentity: Pick<NodeFS.Stats, "dev" | "ino"> | null = null;
  #cleanupInProgress = 0;
  #globalFileCount = 0;
  #globalBytes = 0;
  #storageFault: unknown | null = null;
  #nextEpoch = 1;
  #nextInvocationId = 1;
  #closePromise: Promise<void> | null = null;

  constructor(root: string) {
    if (typeof root !== "string" || !NodePath.isAbsolute(root)) {
      throw materializationError(
        "invalid_input",
        "The integration file cache root must be an absolute path.",
      );
    }
    const normalized = NodePath.resolve(root);
    if (normalized === NodePath.parse(normalized).root) {
      throw materializationError(
        "invalid_input",
        "The integration file cache root must not be the filesystem root.",
      );
    }
    this.#root = normalized;
  }

  initialize(): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#closed) throw revokedError();
      if (this.#initialized) return;
      try {
        await NodeFSP.mkdir(NodePath.dirname(this.#root), { recursive: true, mode: 0o700 });
        const existing = await lstatOrNull(this.#root);
        if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
          throw new Error("The managed integration file root is not a real directory.");
        }
        if (!existing) await NodeFSP.mkdir(this.#root, { mode: 0o700 });
        const root = await NodeFSP.lstat(this.#root);
        if (root.isSymbolicLink() || !root.isDirectory()) {
          throw new Error("The managed integration file root is not a real directory.");
        }
        this.#rootIdentity = { dev: root.dev, ino: root.ino };
        await this.#assertPrivateRoot();
        await this.#removeReservedFiles();
        await this.#assertPrivateRoot();
        this.#globalFileCount = 0;
        this.#globalBytes = 0;
        this.#storageFault = null;
        this.#initialized = true;
      } catch (cause) {
        throw cause instanceof IntegrationFileMaterializationError ? cause : storageError(cause);
      }
    });
  }

  beginInvocation(input: {
    readonly threadId: string;
    readonly sessionId?: string;
    readonly signal: AbortSignal;
  }): IntegrationFileInvocation {
    // Cleanup pauses lease issuance globally. This keeps a new session from publishing into the
    // reserved namespace while an exact-scope or global cleanup is removing the prior epoch.
    if (!this.#initialized || this.#closed || this.#cleanupInProgress > 0) throw revokedError();
    if (this.#storageFault !== null) throw storageError(this.#storageFault);
    if (!(input.signal instanceof AbortSignal)) {
      throw materializationError("invalid_input", "An AbortSignal is required.");
    }
    if (input.signal.aborted) throw revokedError(input.signal.reason);
    const threadId = validateScopeId(input.threadId, "threadId");
    const threadToken = scopeToken("thread", threadId);
    const sessionToken =
      input.sessionId === undefined
        ? scopeToken("default-session", "")
        : scopeToken("session", validateScopeId(input.sessionId, "sessionId"));
    const key = `${threadToken}\0${sessionToken}`;
    let session = this.#sessions.get(key);
    if (!session) {
      session = {
        key,
        threadToken,
        sessionToken,
        epoch: this.#nextEpoch++,
        storageToken: NodeCrypto.randomUUID(),
        files: new Map(),
        totalBytes: 0,
      };
      this.#sessions.set(key, session);
    }
    const lease: InvocationLease = {
      id: this.#nextInvocationId++,
      session,
      epoch: session.epoch,
      signal: input.signal,
      digests: new Set(),
      revoked: false,
      settlement: "active",
      settlementPromise: null,
      removeAbortListener: () => undefined,
    };
    const materializeFile: IntegrationMaterializeFile = (file) =>
      this.#materializeFile(lease, file);
    const commit = () => this.#commitLease(lease);
    const abort = () => this.#settleLease(lease, "aborted");
    const onAbort = () => {
      lease.revoked = true;
      void abort().catch(() => undefined);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    lease.removeAbortListener = () => input.signal.removeEventListener("abort", onAbort);
    this.#leases.add(lease);
    return { materializeFile, commit, abort };
  }

  clearThread(threadId: string): Promise<void> {
    const threadToken = scopeToken("thread", validateScopeId(threadId, "threadId"));
    return this.#cleanup(
      async () => {
        this.#revokeLeases((lease) => lease.session.threadToken === threadToken);
        const sessions = [...this.#sessions.values()].filter(
          (session) => session.threadToken === threadToken,
        );
        for (const session of sessions) {
          await this.#removeSessionFiles(session);
          this.#sessions.delete(session.key);
        }
      },
      (lease) => lease.session.threadToken === threadToken,
    );
  }

  clearSession(threadId: string, sessionId?: string): Promise<void> {
    const threadToken = scopeToken("thread", validateScopeId(threadId, "threadId"));
    const sessionToken =
      sessionId === undefined
        ? scopeToken("default-session", "")
        : scopeToken("session", validateScopeId(sessionId, "sessionId"));
    const key = `${threadToken}\0${sessionToken}`;
    return this.#cleanup(
      async () => {
        this.#revokeLeases((lease) => lease.session.key === key);
        const session = this.#sessions.get(key);
        if (session) {
          await this.#removeSessionFiles(session);
          this.#sessions.delete(key);
        }
      },
      (lease) => lease.session.key === key,
    );
  }

  clearAll(): Promise<void> {
    return this.#cleanup(
      async () => {
        this.#revokeLeases(() => true);
        await this.#assertPrivateRoot();
        for (const session of this.#sessions.values()) {
          await this.#removeSessionFiles(session);
          this.#sessions.delete(session.key);
        }
        await this.#removeReservedFiles();
        this.#storageFault = null;
      },
      () => true,
    );
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#revokeLeases(() => true);
    this.#closePromise = this.#exclusive(async () => {
      if (!this.#initialized) return;
      try {
        await this.#assertPrivateRoot();
        for (const session of this.#sessions.values()) {
          await this.#removeSessionFiles(session);
          this.#sessions.delete(session.key);
        }
        await this.#removeReservedFiles();
        this.#initialized = false;
        this.#rootIdentity = null;
      } catch (cause) {
        throw cause instanceof IntegrationFileMaterializationError ? cause : storageError(cause);
      }
    });
    return this.#closePromise;
  }

  #exclusive<A>(operation: () => Promise<A>): Promise<A> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #cleanup(
    operation: () => Promise<void>,
    revokeImmediately: (lease: InvocationLease) => boolean,
  ): Promise<void> {
    if (!this.#initialized || this.#closed) return Promise.reject(revokedError());
    this.#cleanupInProgress += 1;
    for (const lease of this.#leases) {
      if (revokeImmediately(lease)) lease.revoked = true;
    }
    return this.#exclusive(async () => {
      try {
        await this.#assertPrivateRoot();
        await operation();
      } catch (cause) {
        throw cause instanceof IntegrationFileMaterializationError ? cause : storageError(cause);
      } finally {
        this.#cleanupInProgress -= 1;
      }
    });
  }

  #leaseIsCurrent(lease: InvocationLease): boolean {
    return (
      !this.#closed &&
      this.#storageFault === null &&
      !lease.revoked &&
      lease.settlement === "active" &&
      !lease.signal.aborted &&
      this.#sessions.get(lease.session.key) === lease.session &&
      lease.session.epoch === lease.epoch
    );
  }

  #assertCurrentLease(lease: InvocationLease): void {
    if (!this.#leaseIsCurrent(lease)) throw revokedError(lease.signal.reason);
  }

  async #materializeFile(
    lease: InvocationLease,
    input: IntegrationFileMaterializationInput,
  ): Promise<IntegrationFileDescriptor> {
    this.#assertCurrentLease(lease);
    return this.#exclusive(async () => {
      this.#assertCurrentLease(lease);
      const file = validatedInput(input);
      await this.#assertPrivateRoot().catch((cause) => {
        throw storageError(cause);
      });
      let record = lease.session.files.get(file.digest);
      if (record) {
        await this.#verifyRecord(record, file.digest);
      } else {
        if (
          lease.session.files.size >= INTEGRATION_FILE_MAX_UNIQUE_FILES_PER_SESSION ||
          lease.session.totalBytes + file.bytes.byteLength >
            INTEGRATION_FILE_MAX_UNIQUE_BYTES_PER_SESSION
        ) {
          throw materializationError(
            "quota_exceeded",
            "The integration file session cache quota was exceeded.",
          );
        }
        if (
          this.#globalFileCount >= INTEGRATION_FILE_MAX_UNIQUE_FILES_GLOBAL ||
          this.#globalBytes + file.bytes.byteLength > INTEGRATION_FILE_MAX_UNIQUE_BYTES_GLOBAL
        ) {
          throw materializationError(
            "quota_exceeded",
            "The global integration file cache quota was exceeded.",
          );
        }
        try {
          record = await this.#publish(lease.session, file);
          lease.session.files.set(file.digest, record);
          lease.session.totalBytes += file.bytes.byteLength;
          this.#globalFileCount += 1;
          this.#globalBytes += file.bytes.byteLength;
        } catch (cause) {
          throw cause instanceof IntegrationFileMaterializationError ? cause : storageError(cause);
        }
      }

      if (!lease.digests.has(file.digest)) {
        lease.digests.add(file.digest);
        record.pendingInvocationIds.add(lease.id);
      }
      if (!this.#leaseIsCurrent(lease)) {
        await this.#settleLeaseInternal(lease, "aborted");
        throw revokedError(lease.signal.reason);
      }
      return record.descriptor;
    });
  }

  #settleLease(lease: InvocationLease, settlement: "committed" | "aborted"): Promise<void> {
    if (lease.settlementPromise) return lease.settlementPromise;
    lease.revoked = true;
    lease.removeAbortListener();
    const effectiveSettlement =
      settlement === "committed" && !lease.signal.aborted ? "committed" : "aborted";
    lease.settlementPromise = this.#exclusive(() =>
      this.#settleLeaseInternal(lease, effectiveSettlement),
    );
    return lease.settlementPromise;
  }

  async #commitLease(lease: InvocationLease): Promise<void> {
    if (!this.#leaseIsCurrent(lease)) {
      await this.#settleLease(lease, "aborted");
      throw revokedError(lease.signal.reason);
    }
    await this.#settleLease(lease, "committed");
    if (lease.settlement !== "committed") throw revokedError(lease.signal.reason);
  }

  async #settleLeaseInternal(
    lease: InvocationLease,
    settlement: "committed" | "aborted",
  ): Promise<void> {
    if (lease.settlement !== "active") return;
    lease.revoked = true;
    lease.removeAbortListener();
    const current = this.#sessions.get(lease.session.key) === lease.session;
    let firstCleanupError: unknown;
    for (const digest of lease.digests) {
      const record = lease.session.files.get(digest);
      if (!record) continue;
      record.pendingInvocationIds.delete(lease.id);
      if (settlement === "committed" && current) {
        record.committed = true;
        continue;
      }
      if (!record.committed && record.pendingInvocationIds.size === 0) {
        try {
          await this.#removeRecord(record);
        } catch (cause) {
          firstCleanupError ??= cause;
          continue;
        }
        lease.session.files.delete(digest);
        lease.session.totalBytes -= record.descriptor.sizeBytes;
        this.#globalFileCount -= 1;
        this.#globalBytes -= record.descriptor.sizeBytes;
      }
    }
    lease.digests.clear();
    lease.settlement = settlement;
    this.#leases.delete(lease);
    if (firstCleanupError !== undefined) throw storageError(firstCleanupError);
  }

  #revokeLeases(predicate: (lease: InvocationLease) => boolean): void {
    for (const lease of this.#leases) {
      if (!predicate(lease)) continue;
      lease.revoked = true;
      lease.removeAbortListener();
      for (const digest of lease.digests) {
        lease.session.files.get(digest)?.pendingInvocationIds.delete(lease.id);
      }
      lease.settlement = "aborted";
      lease.digests.clear();
      this.#leases.delete(lease);
    }
  }

  async #assertPrivateRoot(): Promise<void> {
    let handle: Awaited<ReturnType<typeof NodeFSP.open>> | null = null;
    try {
      const entry = await NodeFSP.lstat(this.#root, { bigint: false });
      if (
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        (this.#rootIdentity !== null && !sameFile(entry, this.#rootIdentity))
      ) {
        throw new Error("The managed integration file root is not a real directory.");
      }
      handle = await NodeFSP.open(this.#root, OPEN_READ_FLAGS);
      const root = await handle.stat({ bigint: false });
      if (
        !root.isDirectory() ||
        !sameFile(entry, root) ||
        (this.#rootIdentity !== null && !sameFile(root, this.#rootIdentity))
      ) {
        throw new Error("The managed integration file root is not a real directory.");
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #publish(session: SessionState, file: ValidatedFile): Promise<MaterializedFileRecord> {
    const name = `${INTEGRATION_FILE_RESERVED_PREFIX}${session.storageToken}-${file.digest}${file.extension}`;
    const path = NodePath.join(this.#root, name);
    const temporary = NodePath.join(
      this.#root,
      `${INTEGRATION_FILE_RESERVED_PREFIX}tmp-${NodeCrypto.randomUUID()}.tmp`,
    );
    let temporaryHandle: Awaited<ReturnType<typeof NodeFSP.open>> | null = null;
    let published = false;
    let temporaryStats: NodeFS.Stats | null = null;
    let result: MaterializedFileRecord | null = null;
    let failure: unknown;
    let identityCompromised = false;
    try {
      await this.#assertPrivateRoot();
      temporaryHandle = await NodeFSP.open(temporary, OPEN_TEMP_FLAGS, 0o600);
      await temporaryHandle.writeFile(file.bytes);
      await temporaryHandle.chmod(0o600);
      await temporaryHandle.sync();
      temporaryStats = await temporaryHandle.stat({ bigint: false });
      if (!isPrivateIntegrationFileStat(temporaryStats, { expectedLinkCount: 1 })) {
        identityCompromised = true;
        throw new Error("The staged integration file is not a regular file.");
      }
      await this.#assertPrivateRoot();
      await NodeFSP.link(temporary, path);
      published = true;
      const publishedHandle = await NodeFSP.open(path, OPEN_READ_FLAGS);
      try {
        const linkedStats = await publishedHandle.stat({ bigint: false });
        if (
          !isPrivateIntegrationFileStat(linkedStats, {
            expectedIdentity: temporaryStats,
            expectedLinkCount: 2,
          })
        ) {
          identityCompromised = true;
          throw new Error("The published integration file changed during publication.");
        }
        await NodeFSP.unlink(temporary);
        const finalStats = await publishedHandle.stat({ bigint: false });
        const finalEntry = await NodeFSP.lstat(path, { bigint: false });
        if (
          !isPrivateIntegrationFileStat(finalStats, {
            expectedIdentity: temporaryStats,
            expectedLinkCount: 1,
          }) ||
          !isPrivateIntegrationFileStat(finalEntry, {
            expectedIdentity: finalStats,
            expectedLinkCount: 1,
          })
        ) {
          identityCompromised = true;
          throw new Error("The published integration file changed during publication.");
        }
      } finally {
        await publishedHandle.close();
      }
      await this.#assertPrivateRoot();
      await this.#syncDirectory(this.#root);
      const descriptor: IntegrationFileDescriptor = Object.freeze({
        path,
        name,
        mediaType: file.mediaType,
        sizeBytes: file.bytes.byteLength,
        trust: "untrusted",
      });
      result = {
        digest: file.digest,
        descriptor,
        device: temporaryStats.dev,
        inode: temporaryStats.ino,
        pendingInvocationIds: new Set(),
        committed: false,
      };
    } catch (cause) {
      failure = cause;
    }
    try {
      await temporaryHandle?.close();
    } catch (cause) {
      failure ??= cause;
    }
    if (failure === undefined && result) return result;

    let cleanupFailure: unknown;
    if (published && temporaryStats) {
      try {
        const removed = await this.#unlinkIfSameFile(path, temporaryStats);
        if (!removed) throw new Error("The published integration file changed before rollback.");
      } catch (cause) {
        cleanupFailure ??= cause;
      }
    }
    try {
      await this.#assertPrivateRoot();
      await NodeFSP.unlink(temporary);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailure ??= cause;
    }
    if (cleanupFailure !== undefined || identityCompromised) {
      const fault = new Error("Integration file rollback could not be completed safely.", {
        cause: cleanupFailure ?? failure,
      });
      this.#storageFault ??= fault;
      for (const lease of this.#leases) lease.revoked = true;
      throw storageError(fault);
    }
    throw storageError(failure);
  }

  async #verifyRecord(record: MaterializedFileRecord, digest: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof NodeFSP.open>> | null = null;
    try {
      handle = await NodeFSP.open(record.descriptor.path, OPEN_READ_FLAGS);
      const stats = await handle.stat({ bigint: false });
      const entry = await NodeFSP.lstat(record.descriptor.path, { bigint: false });
      if (
        stats.size !== record.descriptor.sizeBytes ||
        entry.size !== record.descriptor.sizeBytes ||
        !isPrivateIntegrationFileStat(stats, {
          expectedIdentity: { dev: record.device, ino: record.inode },
          expectedLinkCount: 1,
        }) ||
        !isPrivateIntegrationFileStat(entry, {
          expectedIdentity: stats,
          expectedLinkCount: 1,
        })
      ) {
        throw new Error("The materialized integration file changed unexpectedly.");
      }
      const contents = await handle.readFile();
      if (sha256(contents) !== digest) {
        throw new Error("The materialized integration file contents changed unexpectedly.");
      }
    } catch (cause) {
      throw storageError(cause);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #unlinkIfSameFile(
    path: string,
    expected: Pick<NodeFS.Stats, "dev" | "ino">,
    requirePrivateSingleLink = false,
  ): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof NodeFSP.open>> | null = null;
    try {
      handle = await NodeFSP.open(path, OPEN_READ_FLAGS);
      const current = await handle.stat({ bigint: false });
      const entry = await NodeFSP.lstat(path, { bigint: false });
      if (
        (requirePrivateSingleLink &&
          (!isPrivateIntegrationFileStat(current, {
            expectedIdentity: expected,
            expectedLinkCount: 1,
          }) ||
            !isPrivateIntegrationFileStat(entry, {
              expectedIdentity: current,
              expectedLinkCount: 1,
            }))) ||
        (!requirePrivateSingleLink &&
          (!current.isFile() ||
            !entry.isFile() ||
            !sameFile(current, expected) ||
            !sameFile(entry, current)))
      ) {
        return false;
      }
      await NodeFSP.unlink(path);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #removeRecord(record: MaterializedFileRecord): Promise<void> {
    await this.#assertPrivateRoot();
    this.#assertReservedLeafPath(record.descriptor.path);
    const entry = await lstatOrNull(record.descriptor.path);
    if (!entry) throw new Error("A tracked integration file is missing during cleanup.");
    if (
      !isPrivateIntegrationFileStat(entry, {
        expectedIdentity: { dev: record.device, ino: record.inode },
        expectedLinkCount: 1,
      })
    ) {
      throw new Error("A tracked integration file changed before cleanup.");
    }
    const removed = await this.#unlinkIfSameFile(
      record.descriptor.path,
      {
        dev: record.device,
        ino: record.inode,
      },
      true,
    );
    if (!removed) throw new Error("The materialized integration file changed before cleanup.");
    await this.#assertPrivateRoot();
  }

  async #removeSessionFiles(session: SessionState): Promise<void> {
    for (const [digest, record] of session.files) {
      await this.#removeRecord(record);
      session.files.delete(digest);
      session.totalBytes -= record.descriptor.sizeBytes;
      this.#globalFileCount -= 1;
      this.#globalBytes -= record.descriptor.sizeBytes;
    }
    if (session.totalBytes !== 0 || this.#globalFileCount < 0 || this.#globalBytes < 0) {
      throw new Error("Integration file cache accounting became inconsistent.");
    }
  }

  #assertReservedLeafPath(path: string): void {
    if (
      NodePath.dirname(path) !== this.#root ||
      !NodePath.basename(path).startsWith(INTEGRATION_FILE_RESERVED_PREFIX)
    ) {
      throw new Error("Refusing to access a path outside the reserved integration file namespace.");
    }
  }

  async #removeReservedFiles(): Promise<void> {
    await this.#assertPrivateRoot();
    const names = (await NodeFSP.readdir(this.#root)).filter((name) =>
      name.startsWith(INTEGRATION_FILE_RESERVED_PREFIX),
    );
    await this.#assertPrivateRoot();
    const reserved: Array<string> = [];
    for (const name of names) {
      const path = NodePath.join(this.#root, name);
      this.#assertReservedLeafPath(path);
      const entry = await NodeFSP.lstat(path, { bigint: false });
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error("A reserved integration file path is not a regular file or symlink.");
      }
      reserved.push(path);
    }
    await this.#assertPrivateRoot();
    for (const path of reserved) {
      await this.#assertPrivateRoot();
      await NodeFSP.unlink(path).catch((cause) => {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      });
    }
    await this.#assertPrivateRoot();
  }

  async #syncDirectory(path: string): Promise<void> {
    let directory: Awaited<ReturnType<typeof NodeFSP.open>> | null = null;
    try {
      directory = await NodeFSP.open(path, NodeFS.constants.O_RDONLY);
      await directory.sync();
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "EISDIR" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") {
        throw cause;
      }
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }
}
