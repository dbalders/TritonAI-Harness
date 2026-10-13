// @effect-diagnostics nodeBuiltinImport:off - Bounded, no-follow reads of a dedicated task output directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const MAX_BOT_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_BOT_ATTACHMENTS = 3;
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

interface PinnedOutputDirectory {
  readonly canonical: string;
  readonly open: (name: string) => Promise<{
    readonly stat: () => Promise<NodeFS.BigIntStats>;
    readonly read: (bytes: Buffer, offset: number) => Promise<number>;
    readonly close: () => Promise<void>;
  }>;
  readonly close: () => Promise<void>;
}

/** Retain every ancestor descriptor and open files relative to the validated directory. */
async function pinPosixOutputDirectory(
  canonical: string,
  expected: NodeFS.BigIntStats,
): Promise<PinnedOutputDirectory> {
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
          stat: () => statDescriptor(fileFd),
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

/** Only explicitly staged regular files can leave the computer; linked paths and nested directories are excluded. */
export async function collectTaskOutputFiles(directory: string, platform: NodeJS.Platform) {
  const files: Array<{ name: string; mimeType: string; dataBase64: string }> = [];
  const blockers: string[] = [];
  if (platform === "win32")
    return {
      files,
      blockers: [
        "Generated task files cannot currently be safely exported on Windows. Open the task computer's output directory from the Harness assignment to retrieve them. Text results and input attachments remain available.",
      ],
    };
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
  try {
    for (const name of entries.slice(0, 25)) {
      const mimeType = outputMimeTypes[NodePath.extname(name).toLowerCase()];
      if (
        !mimeType ||
        name.length > 180 ||
        Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
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
      let handle: Awaited<ReturnType<PinnedOutputDirectory["open"]>> | undefined;
      try {
        // A hardlink could point at an unrelated local file even with O_NOFOLLOW.
        const file = await pinned.open(name);
        handle = file;
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1n ||
          stat.size < 1n ||
          stat.size > BigInt(MAX_BOT_ATTACHMENT_BYTES)
        ) {
          blockers.push(
            `Output ${name.slice(0, 100)} was not a regular file between 1 byte and 4 MiB.`,
          );
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
        if (offset !== bytes.length || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs) {
          blockers.push(
            `Output ${name.slice(0, 100)} changed while being read; it was not uploaded.`,
          );
          continue;
        }
        files.push({ name, mimeType, dataBase64: bytes.toString("base64") });
      } catch {
        blockers.push(`Output ${name.slice(0, 100)} could not be safely read.`);
      } finally {
        await handle?.close();
      }
    }
    if (entries.length > 25)
      blockers.push("The output directory contained too many entries to inspect completely.");
    return { files, blockers: blockers.slice(0, 10) };
  } finally {
    await pinned.close();
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
