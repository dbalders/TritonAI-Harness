// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  collectTaskOutputFiles,
  MAX_BOT_ATTACHMENT_BYTES,
  prepareTaskOutputDirectory,
  taskOutputDirectory,
  verifiedAttachmentBytes,
} from "./botTaskFiles.ts";

describe("task output staging", () => {
  it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "rejects named pipes without waiting for a writer",
    async () => {
      const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-output-fifo-"));
      try {
        const output = taskOutputDirectory(dir, "thread-1");
        await prepareTaskOutputDirectory(output);
        NodeChildProcess.execFileSync("mkfifo", [NodePath.join(output, "report.txt")]);
        const result = await collectTaskOutputFiles(output);
        expect(result.files).toEqual([]);
        expect(result.blockers).toEqual([
          "Output report.txt was not a regular file between 1 byte and 4 MiB.",
        ]);
      } finally {
        await NodeFSP.rm(dir, { force: true, recursive: true });
      }
    },
  );
  it("uploads staged deliverables without following symlinks, hardlinks, directories or oversize files", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-output-test-"));
    try {
      const output = taskOutputDirectory(dir, "thread-1");
      await prepareTaskOutputDirectory(output);
      const privateFile = NodePath.join(dir, "private.txt");
      await NodeFSP.writeFile(privateFile, "private");
      await NodeFSP.writeFile(NodePath.join(output, "report.txt"), "deliverable");
      await NodeFSP.symlink(privateFile, NodePath.join(output, "linked.txt"));
      await NodeFSP.link(privateFile, NodePath.join(output, "hardlink.txt"));
      await NodeFSP.mkdir(NodePath.join(output, "directory.txt"));
      await NodeFSP.writeFile(
        NodePath.join(output, "oversize.txt"),
        Buffer.alloc(MAX_BOT_ATTACHMENT_BYTES + 1),
      );
      const result = await collectTaskOutputFiles(output);
      expect(result.files).toEqual([
        {
          name: "report.txt",
          mimeType: "text/plain",
          dataBase64: Buffer.from("deliverable").toString("base64"),
        },
      ]);
      expect(result.blockers).toHaveLength(4);
      expect(() => taskOutputDirectory(dir, "../private")).toThrow("Invalid");
    } finally {
      await NodeFSP.rm(dir, { force: true, recursive: true });
    }
  });
  it("fails integrity mismatches before dispatching image bytes", () => {
    expect(() =>
      verifiedAttachmentBytes({
        size: 7,
        dataBase64: Buffer.from("changed").toString("base64"),
        sha256: "a".repeat(64),
      }),
    ).toThrow("integrity");
  });
});
