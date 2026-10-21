// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  Architecture as HostProcessArchitecture,
  Platform as HostProcessPlatform,
} from "@t3tools/shared/HostProcess";
import {
  collectTaskOutputFiles,
  MAX_BOT_ATTACHMENT_BYTES,
  prepareTaskOutputDirectory,
  taskOutputDirectory,
  verifiedAttachmentBytes,
  windowsOutputPath,
} from "./botTaskFiles.ts";

const nativeWindows =
  HostProcessPlatform.defaultValue() === "win32" &&
  HostProcessArchitecture.defaultValue() === "x64";
const windows = { architecture: HostProcessArchitecture.defaultValue() };

describe("task output staging", () => {
  it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "never reads Windows outputs without the native Windows file checks",
    async () => {
      const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-output-windows-"));
      try {
        const output = taskOutputDirectory(dir, "thread-1");
        await prepareTaskOutputDirectory(output);
        await NodeFSP.writeFile(NodePath.join(output, "report.txt"), "Staged bytes");
        // Claiming x64 reaches the real native load, which cannot find ntdll.dll off Windows.
        for (const architecture of ["x64", "arm64", "ia32"] as const)
          expect(
            await collectTaskOutputFiles(output, "win32", { architecture }),
            architecture,
          ).toEqual({
            files: [],
            blockers: [
              "Generated task files could not be exported because this Windows computer could not verify them safely. Open the task computer's output directory from the Harness assignment to retrieve them. Text results and input attachments remain available.",
            ],
          });
        const result = await collectTaskOutputFiles(output, "win32");
        expect(result.files).toEqual([]);
        expect(result.blockers).toEqual([
          "Generated task files could not be exported because this Windows computer could not verify them safely. Open the task computer's output directory from the Harness assignment to retrieve them. Text results and input attachments remain available.",
        ]);
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    },
  );
  it("walks only literal names below a local drive root on Windows", () => {
    expect(windowsOutputPath("C:\\Users\\Ana\\.t3\\bot-deliverables\\thread-1")).toEqual({
      drive: "C",
      names: ["Users", "Ana", ".t3", "bot-deliverables", "thread-1"],
    });
    expect(windowsOutputPath("\\\\?\\d:\\状态\\thread-1")).toEqual({
      drive: "D",
      names: ["状态", "thread-1"],
    });
    for (const unsafe of [
      "\\\\server\\share\\thread-1",
      "\\\\?\\UNC\\server\\share\\thread-1",
      "\\\\.\\C:\\thread-1",
      "C:thread-1",
      "C:\\",
      "C:/Users/thread-1",
      "C:\\Users\\..\\thread-1",
      "C:\\Users\\\\thread-1",
      "C:\\Users\\thread-1\\",
      "C:\\Users.\\thread-1",
      "C:\\Users \\thread-1",
      "C:\\Users\\thread-1:stream",
      "C:\\Users\\thread*",
      `C:\\Users\\${"\uD800"}`,
    ])
      expect(windowsOutputPath(unsafe), unsafe).toBeUndefined();
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
  describe.runIf(nativeWindows)("native Windows collection", () => {
    const fixture = async () => {
      const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-output-native-"));
      const output = taskOutputDirectory(dir, "thread-1");
      await prepareTaskOutputDirectory(output);
      const privateDir = NodePath.join(dir, "private");
      await NodeFSP.mkdir(privateDir);
      await NodeFSP.writeFile(NodePath.join(privateDir, "secret.txt"), "Unrelated private bytes");
      return { dir, output, privateDir, secret: NodePath.join(privateDir, "secret.txt") };
    };
    const text = (file: { dataBase64: string }) =>
      Buffer.from(file.dataBase64, "base64").toString("utf8");

    it("uploads ordinary staged files and rejects hardlinks, junctions and alternate streams", async () => {
      const { dir, output, privateDir, secret } = await fixture();
      try {
        await NodeFSP.writeFile(NodePath.join(output, "Résumé ✓.txt"), "Staged résumé ✓");
        await NodeFSP.writeFile(NodePath.join(output, "report.txt"), "Default stream");
        await NodeFSP.writeFile(NodePath.join(output, "report.txt:secret"), "Hidden stream");
        await NodeFSP.link(secret, NodePath.join(output, "hardlink.txt"));
        await NodeFSP.symlink(privateDir, NodePath.join(output, "junction.txt"), "junction");
        const result = await collectTaskOutputFiles(output, "win32", windows);
        expect(result.files.map((file) => [file.name, file.mimeType, text(file)])).toEqual([
          ["Résumé ✓.txt", "text/plain", "Staged résumé ✓"],
          ["report.txt", "text/plain", "Default stream"],
        ]);
        expect(result.blockers).toEqual([
          "Output hardlink.txt was not a regular file between 1 byte and 4 MiB.",
          "Output junction.txt was not a regular file between 1 byte and 4 MiB.",
        ]);
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    });
    it("refuses an output directory reached through a junction", async () => {
      const { dir, output } = await fixture();
      try {
        const deliverables = NodePath.dirname(output);
        const moved = NodePath.join(dir, "moved");
        await NodeFSP.writeFile(NodePath.join(output, "report.txt"), "Staged bytes");
        await NodeFSP.rename(deliverables, moved);
        await NodeFSP.symlink(moved, deliverables, "junction");
        expect(await collectTaskOutputFiles(output, "win32", windows)).toEqual({
          files: [],
          blockers: ["Task output directory could not be safely read."],
        });
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    });
    it("reads the pinned directory after a path swap and rejects a listed file that was replaced", async () => {
      const { dir, output, privateDir } = await fixture();
      try {
        let staged = output;
        await NodeFSP.writeFile(NodePath.join(privateDir, "a.txt"), "Unrelated private bytes");
        await NodeFSP.writeFile(NodePath.join(output, "a.txt"), "Staged bytes");
        await NodeFSP.writeFile(NodePath.join(output, "b.txt"), "Listed bytes");
        const result = await collectTaskOutputFiles(output, "win32", {
          ...windows,
          pause: async (point) => {
            if (point === "pinned") {
              staged = NodePath.join(dir, "parked");
              await NodeFSP.rename(output, staged);
              await NodeFSP.symlink(privateDir, output, "junction");
            }
            if (point === "listed") {
              await NodeFSP.rm(NodePath.join(staged, "b.txt"));
              await NodeFSP.writeFile(NodePath.join(staged, "b.txt"), "Replacement bytes");
            }
          },
        });
        expect(result.files.map(text)).toEqual(["Staged bytes"]);
        expect(result.blockers).toEqual([
          "Output b.txt changed while being read; it was not uploaded.",
        ]);
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    });
    it("skips a file held open for writing and blocks writers while reading", async () => {
      const { dir, output } = await fixture();
      try {
        const report = NodePath.join(output, "report.txt");
        await NodeFSP.writeFile(report, "Staged bytes");
        const writer = await NodeFSP.open(report, "r+");
        try {
          expect((await collectTaskOutputFiles(output, "win32", windows)).blockers).toEqual([
            "Output report.txt was open for writing in another program; it was not uploaded.",
          ]);
        } finally {
          await writer.close();
        }
        const attempts: string[] = [];
        const result = await collectTaskOutputFiles(output, "win32", {
          ...windows,
          pause: async (point) => {
            if (point !== "opened") return;
            for (const attempt of [
              () => NodeFSP.open(report, "r+").then((handle) => handle.close()),
              () => NodeFSP.rename(report, `${report}.moved`),
            ])
              await attempt().then(
                () => attempts.push("allowed"),
                (cause: NodeJS.ErrnoException) => attempts.push(cause.code ?? "failed"),
              );
          },
        });
        expect(attempts).toHaveLength(2);
        expect(attempts).not.toContain("allowed");
        expect(result.files.map(text)).toEqual(["Staged bytes"]);
      } finally {
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }
    });
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
