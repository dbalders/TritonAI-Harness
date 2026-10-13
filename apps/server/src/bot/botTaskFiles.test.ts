// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  collectTaskOutputFiles,
  MAX_BOT_ATTACHMENT_BYTES,
  prepareTaskOutputDirectory,
  taskOutputDirectory,
  verifiedAttachmentBytes,
} from "./botTaskFiles.ts";

describe("task output staging", () => {
  it("blocks generated output export explicitly on Windows", async () => {
    const result = await collectTaskOutputFiles("not-read-on-windows", "win32");
    expect(result.files).toEqual([]);
    expect(result.blockers).toEqual([
      "Generated task files cannot currently be safely exported on Windows. Open the task computer's output directory from the Harness assignment to retrieve them. Text results and input attachments remain available.",
    ]);
  });
  it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "opens the pinned directory even when its path changes after the last identity check",
    async () => {
      const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-output-open-race-"));
      const output = taskOutputDirectory(dir, "thread-1");
      const replacement = NodePath.join(dir, "unrelated");
      const readdir = NodeFSP.readdir,
        lstat = NodeFSP.lstat;
      let listed = false;
      try {
        await prepareTaskOutputDirectory(output);
        await NodeFSP.mkdir(replacement);
        await NodeFSP.writeFile(NodePath.join(output, "report.txt"), "Approved staged bytes");
        await NodeFSP.writeFile(
          NodePath.join(replacement, "report.txt"),
          "Unrelated private bytes",
        );
        const canonical = await NodeFSP.realpath(output);
        const listing = vi.spyOn(NodeFS.promises, "readdir").mockImplementationOnce((async (
          path: NodeFS.PathLike,
        ) => {
          const result = await readdir(path);
          listed = true;
          return result;
        }) as typeof NodeFSP.readdir);
        const checking = vi.spyOn(NodeFS.promises, "lstat").mockImplementation((async (
          path: NodeFS.PathLike,
          options: { bigint: true },
        ) => {
          const result = await lstat(path, options);
          if (listed && path === canonical) {
            listed = false;
            await NodeFSP.rename(output, NodePath.join(dir, "parked"));
            await NodeFSP.symlink(replacement, output);
          }
          return result;
        }) as typeof NodeFSP.lstat);
        NodeModule.syncBuiltinESMExports();
        try {
          const result = await collectTaskOutputFiles(output, HostProcessPlatform.defaultValue());
          expect(result.files).toEqual([
            {
              name: "report.txt",
              mimeType: "text/plain",
              dataBase64: Buffer.from("Approved staged bytes").toString("base64"),
            },
          ]);
        } finally {
          listing.mockRestore();
          checking.mockRestore();
          NodeModule.syncBuiltinESMExports();
        }
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    },
  );
  it
    .skipIf(HostProcessPlatform.defaultValue() === "win32")
    .each(["directory", "ancestor", "empty-directory"])(
    "reports a blocker when the %s is replaced during listing",
    async (target) => {
      const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-output-race-"));
      const output = taskOutputDirectory(dir, "thread-1");
      const replacement = NodePath.join(dir, "unrelated");
      const replacedPath = target === "ancestor" ? NodePath.dirname(output) : output;
      const unrelatedOutput =
        target === "directory" ? replacement : NodePath.join(replacement, "thread-1");
      const readdir = NodeFSP.readdir;
      try {
        await prepareTaskOutputDirectory(output);
        await NodeFSP.mkdir(unrelatedOutput, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(output, "report.txt"), "Approved staged bytes");
        await NodeFSP.writeFile(
          NodePath.join(unrelatedOutput, "report.txt"),
          "Unrelated private bytes",
        );
        const listing = vi.spyOn(NodeFS.promises, "readdir").mockImplementationOnce((async (
          path: NodeFS.PathLike,
        ) => {
          await NodeFSP.rename(replacedPath, NodePath.join(dir, "parked"));
          if (target === "empty-directory") await NodeFSP.mkdir(replacedPath);
          else await NodeFSP.symlink(replacement, replacedPath);
          return readdir(path);
        }) as typeof NodeFSP.readdir);
        NodeModule.syncBuiltinESMExports();
        try {
          const result = await collectTaskOutputFiles(output, HostProcessPlatform.defaultValue());
          expect(result.files).toEqual([]);
          expect(result.blockers).toEqual([
            "Task output directory changed while files were being listed. No files were exported. Open the Harness thread for the original outputs.",
          ]);
        } finally {
          listing.mockRestore();
          NodeModule.syncBuiltinESMExports();
        }
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "rejects named pipes without waiting for a writer",
    async () => {
      const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-output-fifo-"));
      try {
        const output = taskOutputDirectory(dir, "thread-1");
        await prepareTaskOutputDirectory(output);
        NodeChildProcess.execFileSync("mkfifo", [NodePath.join(output, "report.txt")]);
        const result = await collectTaskOutputFiles(output, HostProcessPlatform.defaultValue());
        expect(result.files).toEqual([]);
        expect(result.blockers).toEqual([
          "Output report.txt was not a regular file between 1 byte and 4 MiB.",
        ]);
      } finally {
        await NodeFSP.rm(dir, { force: true, recursive: true });
      }
    },
  );
  it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "uploads staged deliverables without following symlinks, hardlinks, directories or oversize files",
    async () => {
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
        const result = await collectTaskOutputFiles(output, HostProcessPlatform.defaultValue());
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
    },
  );
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
