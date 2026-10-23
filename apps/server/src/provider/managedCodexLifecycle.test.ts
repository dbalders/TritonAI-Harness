// @effect-diagnostics nodeBuiltinImport:off - These tests execute disposable native updater processes.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Native subprocess tests must select the actual host OS.
const nativePlatform = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- The copied native executable must match the actual host architecture.
const nativeArchitecture = NodeOS.arch();
const nativeExecutable = process.execPath;

const worker = `
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as NodePath from 'node:path';
import * as ProcessRunner from ${JSON.stringify(new URL("../processRunner.ts", import.meta.url).href)};
import { updateTritonAiManagedCodex, ManagedCodexApprovedVersion } from ${JSON.stringify(new URL("./managedCodexUpdate.ts", import.meta.url).href)};
import { resolveManagedCodexBinary, leaseManagedCodexRuntime } from ${JSON.stringify(new URL("./managedCodexRuntime.ts", import.meta.url).href)};
const [mode, binaryPath, homeDirectory, boundPid] = process.argv.slice(1);
const { withManagedCodexLock } = await import(${JSON.stringify(new URL("./managedCodexLock.ts", import.meta.url).href)});
process.on('message', () => {});
const program = Effect.gen(function* () {
  const runner = yield* ProcessRunner.make();
  const fs = yield* FileSystem.FileSystem;
  if (mode === 'session' || mode === 'owner' || mode === 'unleased') {
    if (mode !== 'unleased') {
      const lease = yield* leaseManagedCodexRuntime(binaryPath, runner.run);
      if (lease) yield* lease.bindChild(mode === 'owner' ? Number(boundPid) : process.pid);
    }
    process.send({ phase: mode });
    return yield* Effect.never;
  }
  if (mode === 'exit-replace' || mode === 'release-replace') {
    const root = NodePath.join(homeDirectory, '.agents', 'ucsd', 'runtime', 'codex');
    yield* withManagedCodexLock(root, fs.rename(root + '.lock', root + '.retired-lock').pipe(
      Effect.andThen(fs.makeDirectory(root + '.lock')),
      Effect.andThen(mode === 'exit-replace'
        ? Effect.sync(() => process.send({ phase: 'done' }, () => process.exit(0))).pipe(Effect.andThen(Effect.never))
        : Effect.void),
    ));
    process.send({ phase: 'done' });
    return;
  }
  if (mode === 'recover') {
    const binary = yield* resolveManagedCodexBinary({ binaryPath, homeDirectory, platform: process.platform, environment: process.env, run: runner.run });
    const result = yield* runner.run({ command: binary, args: ['--version'], timeout: '5 seconds', maxOutputBytes: 1024 });
    process.send({ phase: 'done', output: result.stdout });
    return;
  }
  let reportedLock = false;
  const observedFs = FileSystem.FileSystem.of({ ...fs, rename: (source, destination) => fs.rename(source, destination).pipe(Effect.tapError(() => {
    if (mode === 'retry' && !reportedLock) { reportedLock = true; process.send({ phase: 'locked' }); }
    return Effect.void;
  }), Effect.tap(() =>
    mode === 'crash' && destination.includes('.tritonai-codex-backup.')
      ? Effect.sync(() => process.send({ phase: 'backup' })).pipe(Effect.andThen(Effect.never))
      : Effect.void)) });
  const version = yield* updateTritonAiManagedCodex({ binaryPath, run: runner.run }).pipe(Effect.provideService(FileSystem.FileSystem, observedFs));
  process.send({ phase: 'done', output: version });
}).pipe(Effect.provideService(ManagedCodexApprovedVersion, '0.151.0'), Effect.scoped, Effect.provide(NodeServices.layer));
Effect.runPromise(program).then(() => process.disconnect(), (error) => { process.send({ phase: 'error', output: String(error) }); process.disconnect(); process.exitCode = 1; });
`;

async function fixture() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codex lifecycle "));
  const root = NodePath.join(home, ".agents", "ucsd", "runtime");
  const runtimeRoot = NodePath.join(root, "codex");
  const install = NodePath.join(runtimeRoot, "openai-codex-0.146.0");
  const windows = nativePlatform === "win32";
  const nodeName = `node-v${process.versions.node}-${windows ? "win" : nativePlatform}-${nativeArchitecture}`;
  const nodeHome = NodePath.join(root, "node", nodeName);
  const node = NodePath.join(nodeHome, ...(windows ? ["node.exe"] : ["bin", "node"]));
  const npm = NodePath.join(
    nodeHome,
    ...(windows ? [] : ["lib"]),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const binary = NodePath.join(install, ...(windows ? ["codex.cmd"] : ["bin", "codex"]));
  const entry = NodePath.join(
    install,
    "lib",
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  await NodeFSP.mkdir(NodePath.dirname(node), { recursive: true });
  if (windows) await NodeFSP.copyFile(nativeExecutable, node);
  else await NodeFSP.symlink(nativeExecutable, node);
  await NodeFSP.chmod(node, 0o755);
  await NodeFSP.mkdir(NodePath.dirname(npm), { recursive: true });
  await NodeFSP.mkdir(NodePath.dirname(entry), { recursive: true });
  await NodeFSP.mkdir(NodePath.dirname(binary), { recursive: true });
  await NodeFSP.writeFile(entry, "console.log('codex-cli 0.146.0');");
  const relativeNode = windows
    ? `..\\..\\node\\${nodeName}\\node.exe`
    : `../../../node/${nodeName}/bin/node`;
  await NodeFSP.writeFile(
    binary,
    windows
      ? `@echo off\r\nsetlocal\r\nset "SCRIPT_DIR=%~dp0"\r\nset "NODE_BIN=%SCRIPT_DIR%${relativeNode}"\r\n"%NODE_BIN%" "%SCRIPT_DIR%lib\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`
      : `#!/usr/bin/env sh\nset -eu\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nNODE_BIN="$SCRIPT_DIR/${relativeNode}"\nexec "$NODE_BIN" "$SCRIPT_DIR/../lib/node_modules/@openai/codex/bin/codex.js" "$@"\n`,
  );
  await NodeFSP.chmod(binary, 0o755);
  await NodeFSP.writeFile(
    npm,
    `const fs=require('node:fs'),p=require('node:path');
const prefix=process.argv[process.argv.indexOf('--prefix')+1];
const modules=p.join(prefix,${JSON.stringify(windows ? "node_modules" : "lib/node_modules")},'@openai','codex');
fs.mkdirSync(p.join(modules,'bin'),{recursive:true});
fs.writeFileSync(p.join(modules,'bin','codex.js'),"console.log('codex-cli 0.151.0');");
fs.writeFileSync(p.join(modules,'package.json'),JSON.stringify({name:'@openai/codex',version:'0.151.0'}));
const shim=p.join(prefix,${JSON.stringify(windows ? "codex.cmd" : "bin/codex")});
fs.mkdirSync(p.dirname(shim),{recursive:true}); fs.writeFileSync(shim,'generated shim');`,
  );
  const sessionNode = NodePath.join(install, windows ? "session.exe" : "session-node");
  if (windows) await NodeFSP.copyFile(nativeExecutable, sessionNode);
  else await NodeFSP.symlink(nativeExecutable, sessionNode);
  await NodeFSP.chmod(sessionNode, 0o755);
  const children: NodeChildProcess.ChildProcess[] = [];
  function lockDirectory() {
    const script = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CodexDirectoryLock {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$handle = [CodexDirectoryLock]::CreateFile($env:TRITONAI_TEST_RUNTIME_ROOT, 0, 3, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::new(-1)) { throw 'Could not open the disposable directory handle' }
[Console]::WriteLine('locked')
[Console]::Out.Flush()
$null = [Console]::ReadLine()
$null = [CodexDirectoryLock]::CloseHandle($handle)`;
    const child = NodeChildProcess.spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TRITONAI_TEST_RUNTIME_ROOT: install },
      },
    );
    children.push(child);
    const ready = new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("locked")) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Directory lock exited with ${code}`)));
    });
    return { child, ready, exited: NodeEvents.EventEmitter.once(child, "exit") };
  }
  function start(mode: string, childPid?: number) {
    const child = NodeChildProcess.spawn(
      mode === "session" || mode === "unleased" ? sessionNode : nativeExecutable,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        worker,
        mode,
        binary,
        home,
        String(childPid ?? ""),
      ],
      { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    children.push(child);
    let diagnostic = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      diagnostic += chunk.toString();
    });
    const result = new Promise<{ phase: string; output?: string }>((resolve, reject) => {
      child.once("message", (message) => resolve(message as { phase: string; output?: string }));
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Worker exited with ${code}: ${diagnostic}`)));
    });
    return { child, result, exited: NodeEvents.EventEmitter.once(child, "exit") };
  }
  return {
    home,
    binary,
    runtimeRoot,
    install,
    start,
    lockDirectory,
    async close() {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = NodeEvents.EventEmitter.once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      await NodeFSP.rm(home, { recursive: true, force: true });
      await NodeFSP.rm(`${runtimeRoot}.lock`, { recursive: true, force: true });
    },
  };
}

describe("native managed Codex lifecycle", () => {
  it.each(["exit-replace", "release-replace"])(
    "preserves a replacement lock when its former owner exits (%s)",
    async (mode) => {
      const f = await fixture();
      try {
        const owner = f.start(mode);
        expect(await owner.result).toMatchObject({ phase: "done" });
        await owner.exited;
        expect(await NodeFSP.stat(`${f.runtimeRoot}.lock`)).toBeDefined();
      } finally {
        await f.close();
      }
    },
    120_000,
  );

  it("keeps a recorded child protected after the Harness lease owner is killed", async () => {
    const f = await fixture();
    try {
      const child = f.start("unleased");
      expect(await child.result).toMatchObject({ phase: "unleased" });
      const owner = f.start("owner", child.child.pid);
      expect(await owner.result).toMatchObject({ phase: "owner" });
      owner.child.kill("SIGKILL");
      await owner.exited;
      const update = f.start("update");
      expect(await update.result).toMatchObject({
        phase: "error",
        output: expect.stringContaining("deferred"),
      });
      await update.exited;
      child.child.kill("SIGKILL");
      await child.exited;
      const retry = f.start("update");
      expect(await retry.result).toMatchObject({ phase: "done", output: "0.151.0" });
      await retry.exited;
    } finally {
      await f.close();
    }
  }, 120_000);

  it.skipIf(nativePlatform !== "win32")(
    "retries a native Windows directory lock and activates after its handle closes",
    async () => {
      const f = await fixture();
      try {
        const session = f.lockDirectory();
        await session.ready;
        const update = f.start("retry");
        expect(await update.result).toMatchObject({ phase: "locked" });
        const completed = NodeEvents.EventEmitter.once(update.child, "message");
        session.child.stdin?.end("\n");
        await session.exited;
        expect((await completed)[0]).toMatchObject({ phase: "done", output: "0.151.0" });
        await update.exited;
      } finally {
        await f.close();
      }
    },
    120_000,
  );
  it("recovers on restart after the updater is killed between native directory moves", async () => {
    const f = await fixture();
    try {
      const update = f.start("crash");
      const interrupted = await update.result;
      expect(interrupted, JSON.stringify(interrupted)).toMatchObject({ phase: "backup" });
      update.child.kill("SIGKILL");
      await update.exited;
      expect(await NodeFSP.stat(f.binary).catch(() => null)).toBeNull();
      const recovery = f.start("recover");
      expect(await recovery.result).toMatchObject({ phase: "done", output: "codex-cli 0.146.0\n" });
      await recovery.exited;
      expect(await NodeFSP.stat(f.binary)).toBeDefined();
    } finally {
      await f.close();
    }
  }, 120_000);

  it("defers activation while a leased native executable runs, then updates after it exits", async () => {
    const f = await fixture();
    try {
      const session = f.start("session");
      expect(await session.result).toMatchObject({ phase: "session" });
      const update = f.start("update");
      expect(await update.result).toMatchObject({
        phase: "error",
        output: expect.stringContaining("deferred"),
      });
      await update.exited;
      session.child.kill("SIGKILL");
      await session.exited;
      const retry = f.start("update");
      expect(await retry.result).toMatchObject({ phase: "done", output: "0.151.0" });
      await retry.exited;
    } finally {
      await f.close();
    }
  }, 120_000);
});
