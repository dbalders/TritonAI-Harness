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

/** Only explicitly staged regular files can leave the computer; linked paths and nested directories are excluded. */
export async function collectTaskOutputFiles(directory: string) {
  const files: Array<{ name: string; mimeType: string; dataBase64: string }> = [];
  const blockers: string[] = [];
  let entries: Array<string>;
  try {
    const stat = await NodeFSP.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await NodeFSP.lstat(NodePath.dirname(directory))).isSymbolicLink()
    )
      return { files, blockers: ["Task output directory could not be safely read."] };
    entries = (await NodeFSP.readdir(directory)).sort();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { files, blockers };
    throw cause;
  }
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
    let handle: NodeFSP.FileHandle | undefined;
    try {
      // A hardlink could point at an unrelated local file even with O_NOFOLLOW.
      handle = await NodeFSP.open(
        NodePath.join(directory, name),
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size < 1 ||
        stat.size > MAX_BOT_ATTACHMENT_BYTES
      ) {
        blockers.push(
          `Output ${name.slice(0, 100)} was not a regular file between 1 byte and 4 MiB.`,
        );
        continue;
      }
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset !== bytes.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
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
