// @effect-diagnostics nodeBuiltinImport:off - Bounded, no-follow reads of a dedicated task output directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const MAX_BOT_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_BOT_ATTACHMENTS = 3;
const outputMimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};

export function taskOutputDirectory(stateDir: string, threadId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(threadId)) throw new Error("Invalid task output reference");
  return NodePath.join(stateDir, "bot-deliverables", threadId);
}

export async function prepareTaskOutputDirectory(directory: string): Promise<void> {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await NodeFSP.lstat(NodePath.dirname(directory))).isSymbolicLink()
  )
    throw new Error("Task output directory is not a private directory");
}

const statDescriptor = (fd: number): Promise<NodeFS.BigIntStats> =>
  new Promise((resolve, reject) => {
    NodeFS.fstat(fd, { bigint: true }, (error, stat) => (error ? reject(error) : resolve(stat)));
  });
const closeDescriptor = (fd: number): Promise<void> =>
  new Promise((resolve, reject) => {
    NodeFS.close(fd, (error) => (error ? reject(error) : resolve()));
  });
const readDescriptor = (fd: number, bytes: Buffer, offset: number): Promise<number> =>
  new Promise((resolve, reject) => {
    NodeFS.read(fd, bytes, offset, bytes.length - offset, offset, (error, bytesRead) =>
      error ? reject(error) : resolve(bytesRead),
    );
  });
let openAtApi:
  | Promise<(parent: number, name: string, flags: number) => Promise<number>>
  | undefined;
function openAt() {
  return (openAtApi ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const library = "tritonai-bot-output-openat";
    // Resolve libc symbols in the current process on macOS and Linux.
    open({ library, path: "" });
    return async (parent: number, name: string, flags: number) => {
      const result = await load({
        library,
        funcName: "openat",
        retType: DataType.I32,
        paramsType: [DataType.I32, DataType.String, DataType.I32],
        paramsValue: [parent, name, flags],
        errno: true as const,
        runInNewThread: true as const,
      });
      if (result.value < 0)
        throw new Error("Task output path could not be opened without following links");
      return result.value;
    };
  }));
}

interface OutputFileStat {
  /** An ordinary data file with exactly one link, observed through the open handle. */
  readonly regular: boolean;
  readonly size: bigint;
  /** Changes whenever the file's length or content timestamps change. */
  readonly version: string;
}
interface OutputFile {
  readonly stat: () => Promise<OutputFileStat>;
  readonly read: (bytes: Buffer, offset: number) => Promise<number>;
  readonly close: () => Promise<void>;
}
interface PinnedOutputDirectory {
  readonly open: (name: string) => Promise<OutputFile>;
  readonly close: () => Promise<void>;
}
/** A staged file the platform layer refused for a reason the owner can act on. */
class OutputFileRejection extends Error {
  readonly reason: "in-use" | "not-regular" | "changed";
  constructor(reason: OutputFileRejection["reason"]) {
    super(`Task output file rejected: ${reason}`);
    this.reason = reason;
  }
}

/** Retain every ancestor descriptor and open files relative to the validated directory. */
async function pinPosixOutputDirectory(
  canonical: string,
  expected: NodeFS.BigIntStats,
): Promise<PinnedOutputDirectory & { readonly canonical: string }> {
  const root = NodePath.parse(canonical).root;
  const rootHandle = await NodeFSP.open(
    root,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
  );
  const descriptors: number[] = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([
      ...descriptors.toReversed().map(closeDescriptor),
      rootHandle.close(),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  try {
    const relativeOpen = await openAt();
    let fd = rootHandle.fd;
    for (const component of canonical.slice(root.length).split(NodePath.sep).filter(Boolean)) {
      fd = await relativeOpen(
        fd,
        component,
        NodeFS.constants.O_RDONLY |
          NodeFS.constants.O_DIRECTORY |
          NodeFS.constants.O_NOFOLLOW |
          NodeFS.constants.O_NONBLOCK,
      );
      descriptors.push(fd);
    }
    const actual = await statDescriptor(fd);
    if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino)
      throw new Error("Task output directory changed before it could be pinned");
    const directoryFd = fd;
    return {
      canonical,
      close,
      open: async (name) => {
        const fileFd = await relativeOpen(
          directoryFd,
          name,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
        );
        return {
          stat: async () => {
            const stat = await statDescriptor(fileFd);
            return {
              regular: stat.isFile() && stat.nlink === 1n,
              size: stat.size,
              version: `${stat.size}:${stat.mtimeNs}`,
            };
          },
          read: (bytes, offset) => readDescriptor(fileFd, bytes, offset),
          close: () => closeDescriptor(fileFd),
        };
      },
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}

async function pinOutputDirectory(directory: string, expected: NodeFS.BigIntStats) {
  return pinPosixOutputDirectory(await NodeFSP.realpath(directory), expected);
}

const sameOutputDirectory = async (path: string, expected: NodeFS.BigIntStats) => {
  try {
    const current = await NodeFSP.lstat(path, { bigint: true });
    return (
      current.isDirectory() &&
      !current.isSymbolicLink() &&
      current.dev === expected.dev &&
      current.ino === expected.ino
    );
  } catch {
    return false;
  }
};

type CollectedOutputs = {
  files: Array<{ name: string; mimeType: string; dataBase64: string }>;
  blockers: string[];
};

/**
 * Only explicitly staged regular files can leave the computer; linked paths and nested directories
 * are excluded. Windows also needs the host architecture, and fails closed without it.
 */
export async function collectTaskOutputFiles(
  directory: string,
  platform: NodeJS.Platform,
  windows?: { readonly architecture: NodeJS.Architecture; readonly pause?: WindowsOutputPause },
): Promise<CollectedOutputs> {
  if (platform === "win32") return collectWindowsOutputFiles(directory, windows);
  const files: CollectedOutputs["files"] = [];
  const blockers: string[] = [];
  let entries: Array<string>;
  let pinned: Awaited<ReturnType<typeof pinOutputDirectory>>;
  let observedDirectory = false;
  try {
    const stat = await NodeFSP.lstat(directory, { bigint: true });
    observedDirectory = true;
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await NodeFSP.lstat(NodePath.dirname(directory))).isSymbolicLink()
    )
      return { files, blockers: ["Task output directory could not be safely read."] };
    pinned = await pinOutputDirectory(directory, stat);
    try {
      if (!(await sameOutputDirectory(pinned.canonical, stat))) {
        await pinned.close();
        return {
          files,
          blockers: [
            "Task output directory changed before files could be listed. No files were exported. Open the Harness thread for the original outputs.",
          ],
        };
      }
      entries = (await NodeFSP.readdir(pinned.canonical)).sort();
      if (!(await sameOutputDirectory(pinned.canonical, stat))) {
        await pinned.close();
        return {
          files,
          blockers: [
            "Task output directory changed while files were being listed. No files were exported. Open the Harness thread for the original outputs.",
          ],
        };
      }
    } catch (cause) {
      await pinned.close();
      throw cause;
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT" && !observedDirectory)
      return { files, blockers };
    throw cause;
  }
  return readStagedFiles(pinned, entries.slice(0, MAX_OUTPUT_ENTRIES), entries.length, () => true);
}

const MAX_OUTPUT_ENTRIES = 25;
const unsupportedOutputBlocker = (name: string, reason: OutputFileRejection["reason"]) =>
  reason === "in-use"
    ? `Output ${name.slice(0, 100)} was open for writing in another program; it was not uploaded.`
    : reason === "changed"
      ? `Output ${name.slice(0, 100)} changed while being read; it was not uploaded.`
      : `Output ${name.slice(0, 100)} was not a regular file between 1 byte and 4 MiB.`;

/** Apply the staged-file policy to the first sorted entries of a pinned output directory, then close it. */
async function readStagedFiles(
  pinned: PinnedOutputDirectory,
  names: ReadonlyArray<string>,
  entryCount: number,
  platformAllowsName: (name: string) => boolean,
): Promise<CollectedOutputs> {
  const files: CollectedOutputs["files"] = [];
  const blockers: string[] = [];
  try {
    for (const name of names) {
      const mimeType = outputMimeTypes[NodePath.extname(name).toLowerCase()];
      if (
        !mimeType ||
        name.length > 180 ||
        hasControlCharacter(name) ||
        !platformAllowsName(name)
      ) {
        blockers.push("An output file was skipped because its name or format is unsupported.");
        continue;
      }
      if (files.length >= MAX_BOT_ATTACHMENTS) {
        blockers.push(
          "Only the first three supported output files were returned. Open the Harness thread for the rest.",
        );
        break;
      }
      let handle: OutputFile | undefined;
      try {
        // A hardlink could point at an unrelated local file even with O_NOFOLLOW.
        const file = await pinned.open(name);
        handle = file;
        const stat = await file.stat();
        if (!stat.regular || stat.size < 1n || stat.size > BigInt(MAX_BOT_ATTACHMENT_BYTES)) {
          blockers.push(unsupportedOutputBlocker(name, "not-regular"));
          continue;
        }
        const bytes = Buffer.alloc(Number(stat.size));
        let offset = 0;
        while (offset < bytes.length) {
          const bytesRead = await file.read(bytes, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await file.stat();
        if (offset !== bytes.length || after.version !== stat.version) {
          blockers.push(unsupportedOutputBlocker(name, "changed"));
          continue;
        }
        files.push({ name, mimeType, dataBase64: bytes.toString("base64") });
      } catch (cause) {
        blockers.push(
          cause instanceof OutputFileRejection
            ? unsupportedOutputBlocker(name, cause.reason)
            : `Output ${name.slice(0, 100)} could not be safely read.`,
        );
      } finally {
        await handle?.close();
      }
    }
    if (entryCount > MAX_OUTPUT_ENTRIES)
      blockers.push("The output directory contained too many entries to inspect completely.");
    return { files, blockers: blockers.slice(0, 10) };
  } finally {
    await pinned.close();
  }
}

const WINDOWS_EXPORT_UNAVAILABLE =
  "Generated task files could not be exported because this Windows computer could not verify them safely. Open the task computer's output directory from the Harness assignment to retrieve them. Text results and input attachments remain available.";
const UNSAFE_OUTPUT_DIRECTORY = "Task output directory could not be safely read.";

/** Test-only pause points on Windows, used to race path replacements against the pinned handles. */
export type WindowsOutputPause = (
  point: "walked" | "pinned" | "listed" | "opened",
  name: string,
) => Promise<void>;

// Windows NT constants: ntifs.h, wdm.h, ntdef.h and winnt.h.
const STATUS_SUCCESS = 0;
const STATUS_NO_MORE_FILES = 0x8000_0006;
const STATUS_END_OF_FILE = 0xc000_0011;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc000_0034;
const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000_003a;
const STATUS_SHARING_VIOLATION = 0xc000_0043;
const STATUS_FILE_IS_A_DIRECTORY = 0xc000_00ba;
const STATUS_OPLOCK_BREAK_IN_PROGRESS = 0x0000_0108;
const FILE_READ_DATA = 0x0001; // FILE_LIST_DIRECTORY on directories
const FILE_TRAVERSE = 0x0020;
const FILE_READ_ATTRIBUTES = 0x0080;
const SYNCHRONIZE = 0x0010_0000;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_ALL = 0x7;
const FILE_DIRECTORY_FILE = 0x0000_0001;
const FILE_SEQUENTIAL_ONLY = 0x0000_0004;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x0000_0020;
const FILE_NON_DIRECTORY_FILE = 0x0000_0040;
const FILE_COMPLETE_IF_OPLOCKED = 0x0000_0100;
const FILE_OPEN_REPARSE_POINT = 0x0020_0000;
const OBJ_CASE_INSENSITIVE = 0x0000_0040;
const OBJ_DONT_REPARSE = 0x0000_1000;
const FILE_ATTRIBUTE_DIRECTORY = 0x0000_0010;
const FILE_ATTRIBUTE_DEVICE = 0x0000_0040;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0000_0400;
const FILE_ATTRIBUTE_OFFLINE = 0x0000_1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x0004_0000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x0040_0000;
const FileBasicInformation = 4;
const FileStandardInformation = 5;
const FileInternalInformation = 6;
const FileIdBothDirectoryInformation = 37;
const FileFsDeviceInformation = 4;
const FileFsAttributeInformation = 5;
const FILE_DEVICE_DISK = 0x7;
const FILE_REMOTE_DEVICE = 0x10;
const HEAP_ZERO_MEMORY = 0x8;

interface WindowsFileApi {
  /** NtOpenFile relative to `parent` (0 for an absolute NT path). Any returned handle is owned by the caller. */
  readonly open: (
    parent: bigint,
    name: string,
    access: number,
    share: number,
    options: number,
    attributes: number,
  ) => Promise<{ readonly status: number; readonly handle: bigint }>;
  readonly query: (handle: bigint, information: Buffer, informationClass: number) => number;
  readonly queryVolume: (handle: bigint, information: Buffer, informationClass: number) => number;
  readonly list: (
    handle: bigint,
    information: Buffer,
    restart: boolean,
  ) => Promise<{ readonly status: number; readonly bytes: number }>;
  readonly read: (
    handle: bigint,
    bytes: Buffer,
    offset: number,
  ) => Promise<{ readonly status: number; readonly bytes: number }>;
  readonly close: (handle: bigint) => number;
}

let windowsFileApi: Promise<WindowsFileApi> | undefined;
/**
 * Native-API bindings for 64-bit Windows. Every handle, pointer and SIZE_T is passed as a 64-bit
 * integer and NTSTATUS results are read directly, so no thread-local last-error state is involved.
 */
function loadWindowsFileApi(): Promise<WindowsFileApi> {
  return (windowsFileApi ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const ntdll = "tritonai-bot-output-ntdll";
    const kernel32 = "tritonai-bot-output-kernel32";
    // Both are KnownDLLs, so these names always resolve to the system copies.
    open({ library: ntdll, path: "ntdll.dll" });
    open({ library: kernel32, path: "kernel32.dll" });
    const heap = load({
      library: kernel32,
      funcName: "GetProcessHeap",
      retType: DataType.BigInt,
      paramsType: [],
      paramsValue: [],
    }) as bigint;
    if (!heap) throw new Error("Windows process heap is unavailable");
    const status = (value: number) => value >>> 0;
    const information = (statusBlock: Buffer) => Number(statusBlock.readBigUInt64LE(8));
    return {
      open: async (parent, name, access, share, options, attributes) => {
        // OBJECT_ATTRIBUTES (48 bytes), UNICODE_STRING (16 bytes) and the name share one block,
        // because the kernel reads them through the absolute pointers stored inside it.
        const nameBytes = Buffer.from(name, "utf16le");
        if (!nameBytes.length || nameBytes.length > 0xfffe) throw new Error("Invalid name length");
        const layout = Buffer.alloc(64 + nameBytes.length);
        const block = load({
          library: kernel32,
          funcName: "HeapAlloc",
          retType: DataType.BigInt,
          paramsType: [DataType.BigInt, DataType.U32, DataType.BigInt],
          paramsValue: [heap, HEAP_ZERO_MEMORY, BigInt(layout.length)],
        }) as bigint;
        if (!block) throw new Error("Windows path buffer could not be allocated");
        try {
          layout.writeUInt32LE(48, 0);
          layout.writeBigUInt64LE(parent, 8);
          layout.writeBigUInt64LE(block + 48n, 16);
          layout.writeUInt32LE(attributes, 24);
          layout.writeUInt16LE(nameBytes.length, 48);
          layout.writeUInt16LE(nameBytes.length, 50);
          layout.writeBigUInt64LE(block + 64n, 56);
          nameBytes.copy(layout, 64);
          load({
            library: kernel32,
            funcName: "RtlMoveMemory",
            retType: DataType.Void,
            paramsType: [DataType.BigInt, DataType.U8Array, DataType.BigInt],
            paramsValue: [block, layout, BigInt(layout.length)],
          });
          const handle = Buffer.alloc(8);
          const result = await load({
            library: ntdll,
            funcName: "NtOpenFile",
            retType: DataType.U32,
            paramsType: [
              DataType.U8Array,
              DataType.U32,
              DataType.BigInt,
              DataType.U8Array,
              DataType.U32,
              DataType.U32,
            ],
            paramsValue: [handle, access, block, Buffer.alloc(16), share, options],
            runInNewThread: true as const,
          });
          return { status: status(result), handle: handle.readBigUInt64LE(0) };
        } finally {
          load({
            library: kernel32,
            funcName: "HeapFree",
            retType: DataType.I32,
            paramsType: [DataType.BigInt, DataType.U32, DataType.BigInt],
            paramsValue: [heap, 0, block],
          });
        }
      },
      query: (handle, buffer, informationClass) =>
        status(
          load({
            library: ntdll,
            funcName: "NtQueryInformationFile",
            retType: DataType.U32,
            paramsType: [
              DataType.BigInt,
              DataType.U8Array,
              DataType.U8Array,
              DataType.U32,
              DataType.U32,
            ],
            paramsValue: [handle, Buffer.alloc(16), buffer, buffer.length, informationClass],
          }),
        ),
      queryVolume: (handle, buffer, informationClass) =>
        status(
          load({
            library: ntdll,
            funcName: "NtQueryVolumeInformationFile",
            retType: DataType.U32,
            paramsType: [
              DataType.BigInt,
              DataType.U8Array,
              DataType.U8Array,
              DataType.U32,
              DataType.U32,
            ],
            paramsValue: [handle, Buffer.alloc(16), buffer, buffer.length, informationClass],
          }),
        ),
      list: async (handle, buffer, restart) => {
        const statusBlock = Buffer.alloc(16);
        const result = await load({
          library: ntdll,
          funcName: "NtQueryDirectoryFile",
          retType: DataType.U32,
          paramsType: [
            DataType.BigInt,
            DataType.BigInt,
            DataType.BigInt,
            DataType.BigInt,
            DataType.U8Array,
            DataType.U8Array,
            DataType.U32,
            DataType.U32,
            DataType.U8,
            DataType.BigInt,
            DataType.U8,
          ],
          paramsValue: [
            handle,
            0n,
            0n,
            0n,
            statusBlock,
            buffer,
            buffer.length,
            FileIdBothDirectoryInformation,
            0,
            0n,
            restart ? 1 : 0,
          ],
          runInNewThread: true as const,
        });
        return { status: status(result), bytes: information(statusBlock) };
      },
      read: async (handle, bytes, offset) => {
        const statusBlock = Buffer.alloc(16);
        const byteOffset = Buffer.alloc(8);
        byteOffset.writeBigInt64LE(BigInt(offset));
        const target = bytes.subarray(offset);
        const result = await load({
          library: ntdll,
          funcName: "NtReadFile",
          retType: DataType.U32,
          paramsType: [
            DataType.BigInt,
            DataType.BigInt,
            DataType.BigInt,
            DataType.BigInt,
            DataType.U8Array,
            DataType.U8Array,
            DataType.U32,
            DataType.U8Array,
            DataType.BigInt,
          ],
          paramsValue: [handle, 0n, 0n, 0n, statusBlock, target, target.length, byteOffset, 0n],
          runInNewThread: true as const,
        });
        return { status: status(result), bytes: information(statusBlock) };
      },
      close: (handle) =>
        status(
          load({
            library: ntdll,
            funcName: "NtClose",
            retType: DataType.U32,
            paramsType: [DataType.BigInt],
            paramsValue: [handle],
          }),
        ),
    } satisfies WindowsFileApi;
  }));
}

const hasControlCharacter = (name: string) =>
  Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
/** One literal NTFS name: no separators, stream syntax, wildcards, lone surrogates or Win32-stripped endings. */
const windowsNameAllowed = (name: string) =>
  name.length > 0 &&
  name.length <= 255 &&
  name !== "." &&
  name !== ".." &&
  !hasControlCharacter(name) &&
  !/[<>:"/\\|?*]|\p{Cs}|[. ]$/u.test(name);
/** Staged names must also not alias a DOS device when the owner saves the download on Windows. */
const windowsEntryNameAllowed = (name: string) =>
  windowsNameAllowed(name) &&
  !/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(name);

/** Split a normalized drive-letter path into the literal names walked below the volume root. */
export function windowsOutputPath(
  directory: string,
): { readonly drive: string; readonly names: ReadonlyArray<string> } | undefined {
  const path = directory.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/u, "");
  const match = /^([A-Za-z]):\\(.+)$/u.exec(path);
  if (!match || NodePath.win32.normalize(path) !== path) return undefined;
  const names = match[2]!.split("\\");
  return names.every(windowsNameAllowed) ? { drive: match[1]!.toUpperCase(), names } : undefined;
}

/**
 * Walk from the volume root to the output directory one literal name at a time, each relative to
 * the previous kernel handle, then list and open files relative to the final handle. No reparse
 * point is followed or accepted anywhere on the path, and files are bound to their listed file ID.
 */
async function collectWindowsOutputFiles(
  directory: string,
  host:
    | { readonly architecture: NodeJS.Architecture; readonly pause?: WindowsOutputPause }
    | undefined,
): Promise<CollectedOutputs> {
  const unavailable = { files: [], blockers: [WINDOWS_EXPORT_UNAVAILABLE] };
  // Handle, pointer and structure layouts below are the 64-bit ones; Windows releases ship x64.
  // Elsewhere ntdll.dll cannot load, so a mislabeled host also fails closed below.
  if (host?.architecture !== "x64") return unavailable;
  const pause = host.pause;
  let api: WindowsFileApi;
  try {
    api = await loadWindowsFileApi();
  } catch {
    return unavailable;
  }
  const path = windowsOutputPath(directory);
  if (!path) return { files: [], blockers: [UNSAFE_OUTPUT_DIRECTORY] };
  const owned = new Set<bigint>();
  const take = (handle: bigint) => {
    if (handle) owned.add(handle);
    return handle;
  };
  const release = (handle: bigint) => {
    if (owned.delete(handle) && api.close(handle) !== STATUS_SUCCESS)
      throw new Error("Task output handle could not be closed");
  };
  const releaseAll = () => {
    let failed = false;
    for (const handle of [...owned].toReversed()) {
      owned.delete(handle);
      if (api.close(handle) !== STATUS_SUCCESS) failed = true;
    }
    if (failed) throw new Error("Task output handle could not be closed");
  };
  let pinned: PinnedOutputDirectory | undefined;
  try {
    const attributesOf = (handle: bigint) => {
      const basic = Buffer.alloc(40);
      if (api.query(handle, basic, FileBasicInformation) !== STATUS_SUCCESS)
        throw new Error("Task output attributes could not be read");
      return basic;
    };
    const isPlainDirectory = (handle: bigint) => {
      const attributes = attributesOf(handle).readUInt32LE(32);
      return (
        (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 &&
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) === 0
      );
    };
    const root = await api.open(
      0n,
      `\\??\\${path.drive}:\\`,
      FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_ALL,
      FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
      OBJ_CASE_INSENSITIVE,
    );
    let current = take(root.handle);
    if (root.status !== STATUS_SUCCESS || !current) return unavailable;
    // Reparse attributes, link counts and 64-bit file IDs are checked with NTFS semantics.
    const device = Buffer.alloc(8);
    const volume = Buffer.alloc(12 + 64);
    if (
      api.queryVolume(current, device, FileFsDeviceInformation) !== STATUS_SUCCESS ||
      device.readUInt32LE(0) !== FILE_DEVICE_DISK ||
      (device.readUInt32LE(4) & FILE_REMOTE_DEVICE) !== 0 ||
      api.queryVolume(current, volume, FileFsAttributeInformation) !== STATUS_SUCCESS ||
      volume.readUInt32LE(8) !== 8 ||
      volume.toString("utf16le", 12, 20) !== "NTFS" ||
      !isPlainDirectory(current)
    )
      return unavailable;
    for (const [index, name] of path.names.entries()) {
      const last = index === path.names.length - 1;
      const next = await api.open(
        current,
        name,
        (last ? FILE_READ_DATA : 0) | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_ALL,
        FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
        OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
      );
      take(next.handle);
      // The child handle now pins its own directory, independent of the parent's path.
      release(current);
      current = next.handle;
      if (
        next.status === STATUS_OBJECT_NAME_NOT_FOUND ||
        next.status === STATUS_OBJECT_PATH_NOT_FOUND
      )
        return { files: [], blockers: [] };
      if (next.status !== STATUS_SUCCESS || !current || !isPlainDirectory(current))
        return { files: [], blockers: [UNSAFE_OUTPUT_DIRECTORY] };
      await pause?.(last ? "pinned" : "walked", name);
    }
    const directoryHandle = current;
    // Keep the 25 first names in JavaScript sort order without holding an unbounded listing.
    const listed: Array<{ readonly name: string; readonly id: bigint }> = [];
    let entryCount = 0;
    const listing = Buffer.alloc(64 * 1024);
    for (let restart = true; ; restart = false) {
      const page = await api.list(directoryHandle, listing, restart);
      if (page.status === STATUS_NO_MORE_FILES) break;
      if (page.status !== STATUS_SUCCESS || page.bytes < 104 || page.bytes > listing.length)
        throw new Error("Task output directory could not be listed");
      for (let offset = 0; ;) {
        // FILE_ID_BOTH_DIR_INFORMATION: FileNameLength at 60, FileId at 96, FileName at 104.
        const nameLength = listing.readUInt32LE(offset + 60);
        const end = offset + 104 + nameLength;
        if (nameLength % 2 || end > page.bytes)
          throw new Error("Task output directory listing was malformed");
        const name = listing.toString("utf16le", offset + 104, end);
        if (name !== "." && name !== "..") {
          entryCount += 1;
          const position = listed.findIndex((entry) => name < entry.name);
          if (position >= 0 || listed.length < MAX_OUTPUT_ENTRIES)
            listed.splice(position >= 0 ? position : listed.length, 0, {
              name,
              id: listing.readBigUInt64LE(offset + 96),
            });
          if (listed.length > MAX_OUTPUT_ENTRIES) listed.pop();
        }
        const nextEntry = listing.readUInt32LE(offset);
        if (!nextEntry) break;
        if (nextEntry < 104 || offset + nextEntry + 104 > page.bytes)
          throw new Error("Task output directory listing was malformed");
        offset += nextEntry;
      }
    }
    await pause?.("listed", "");
    const ids = new Map(listed.map((entry) => [entry.name, entry.id]));
    pinned = {
      close: async () => releaseAll(),
      open: async (name) => {
        const id = ids.get(name);
        if (id === undefined) throw new Error("Task output file was not listed");
        // Without write or delete sharing, no other handle can change or rename the file while
        // it is read, and a file already open for writing fails with a sharing violation.
        const opened = await api.open(
          directoryHandle,
          name,
          FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_SHARE_READ,
          FILE_NON_DIRECTORY_FILE |
            FILE_SYNCHRONOUS_IO_NONALERT |
            FILE_OPEN_REPARSE_POINT |
            FILE_COMPLETE_IF_OPLOCKED |
            FILE_SEQUENTIAL_ONLY,
          OBJ_DONT_REPARSE,
        );
        const handle = take(opened.handle);
        try {
          if (
            opened.status === STATUS_SHARING_VIOLATION ||
            opened.status === STATUS_OPLOCK_BREAK_IN_PROGRESS
          )
            throw new OutputFileRejection("in-use");
          if (opened.status === STATUS_FILE_IS_A_DIRECTORY)
            throw new OutputFileRejection("not-regular");
          if (opened.status !== STATUS_SUCCESS || !handle)
            throw new Error("Task output file could not be opened");
          // The name may have been replaced since listing; only the listed file is accepted.
          const internal = Buffer.alloc(8);
          if (api.query(handle, internal, FileInternalInformation) !== STATUS_SUCCESS)
            throw new Error("Task output file identity could not be read");
          if (internal.readBigUInt64LE(0) !== id) throw new OutputFileRejection("changed");
          await pause?.("opened", name);
        } catch (cause) {
          release(handle);
          throw cause;
        }
        return {
          stat: async () => {
            const basic = attributesOf(handle);
            const standard = Buffer.alloc(24);
            if (api.query(handle, standard, FileStandardInformation) !== STATUS_SUCCESS)
              throw new Error("Task output file size could not be read");
            const attributes = basic.readUInt32LE(32);
            const size = standard.readBigInt64LE(8);
            return {
              regular:
                (attributes &
                  (FILE_ATTRIBUTE_DIRECTORY |
                    FILE_ATTRIBUTE_DEVICE |
                    FILE_ATTRIBUTE_REPARSE_POINT |
                    FILE_ATTRIBUTE_OFFLINE |
                    FILE_ATTRIBUTE_RECALL_ON_OPEN |
                    FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)) ===
                  0 &&
                standard.readUInt32LE(16) === 1 &&
                standard[20] === 0 &&
                standard[21] === 0,
              size,
              version: `${size}:${basic.readBigInt64LE(16)}:${basic.readBigInt64LE(24)}:${attributes}`,
            };
          },
          read: async (bytes, offset) => {
            const result = await api.read(handle, bytes, offset);
            if (result.status === STATUS_END_OF_FILE) return 0;
            if (result.status !== STATUS_SUCCESS || result.bytes > bytes.length - offset)
              throw new Error("Task output file could not be read");
            return result.bytes;
          },
          close: async () => release(handle),
        };
      },
    };
    return await readStagedFiles(
      pinned,
      listed.map((entry) => entry.name),
      entryCount,
      windowsEntryNameAllowed,
    );
  } finally {
    // readStagedFiles closes the pinned directory; this covers every earlier exit.
    if (!pinned) releaseAll();
  }
}

export function verifiedAttachmentBytes(input: {
  dataBase64: string;
  size: number;
  sha256: string;
}): Uint8Array {
  if (input.dataBase64.length > Math.ceil(MAX_BOT_ATTACHMENT_BYTES / 3) * 4)
    throw new Error("Attachment exceeds 4 MiB");
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_BOT_ATTACHMENT_BYTES ||
    bytes.toString("base64") !== input.dataBase64 ||
    bytes.length !== input.size ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== input.sha256
  )
    throw new Error("Attachment bytes failed integrity validation");
  return bytes;
}
