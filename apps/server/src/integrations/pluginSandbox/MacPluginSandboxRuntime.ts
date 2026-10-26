// @effect-diagnostics nodeBuiltinImport:off -- Private snapshots bind reviewed native/runtime bytes before any provider factory executes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { compareSemverVersions } from "@t3tools/shared/semver";
import type { IsolatedPluginRuntime } from "./IsolatedPluginAdapter.ts";
import { runMacPluginWorker } from "./PluginSandboxWorker.ts";
import { QUICKJS_EXECUTION_PROFILE, QUICKJS_RUNTIME_FILES } from "./QuickJsRuntimeProfile.ts";

interface PinnedFile {
  readonly path: string;
  readonly sha256: string;
}

export async function createMacPluginSandboxRuntime(input: {
  readonly platform: NodeJS.Platform;
  readonly parentDirectory: string;
  readonly runtime: PinnedFile;
  readonly supervisor: PinnedFile;
  readonly bootstrap: PinnedFile;
  readonly engine: PinnedFile;
  readonly bridge: PinnedFile;
}): Promise<IsolatedPluginRuntime & AsyncDisposable> {
  if (input.platform !== "darwin" || !NodePath.isAbsolute(input.parentDirectory))
    throw new Error("The isolated plugin OS boundary is unavailable.");
  for (const key of ["bootstrap", "engine", "bridge"] as const) {
    if (input[key]?.sha256 !== QUICKJS_RUNTIME_FILES[key].sha256)
      throw new Error("The plugin interpreter does not match the host execution profile.");
  }
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(input.parentDirectory, "plugin-runtime-")),
  );
  await NodeFSP.chmod(root, 0o700);
  const snapshot = async (source: PinnedFile, name: string, maximum: number) => {
    if (!NodePath.isAbsolute(source.path) || !/^[a-f0-9]{64}$/u.test(source.sha256))
      throw new Error("The plugin runtime pin is invalid.");
    const handle = await NodeFSP.open(source.path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maximum)
        throw new Error("The plugin runtime file is invalid.");
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read({ buffer, position: 0 });
      const bytes = buffer.subarray(0, bytesRead);
      if (
        bytes.length !== stat.size ||
        NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== source.sha256
      )
        throw new Error("The plugin runtime file does not match its host pin.");
      const target = NodePath.join(root, name);
      await NodeFSP.writeFile(target, bytes, { mode: 0o500, flag: "wx" });
      return target;
    } finally {
      await handle.close();
    }
  };
  try {
    const runtime = await snapshot(input.runtime, "node", 200 * 1024 * 1024);
    const supervisor = await snapshot(input.supervisor, "supervisor", 2 * 1024 * 1024);
    const bootstrap = await snapshot(input.bootstrap, "worker.cjs", 256 * 1024);
    const engine = await snapshot(input.engine, "engine.wasm", 1024 * 1024);
    const bridge = await snapshot(input.bridge, "guest-bridge.js", 64 * 1024);
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(runtime, ["--version"], {
      env: {},
      timeout: 5_000,
      maxBuffer: 128,
    });
    const version = stdout.trim().replace(/^v/u, "");
    if (!/^24\.\d+\.\d+$/u.test(version) || compareSemverVersions(version, "24.13.1") < 0)
      throw new Error("The isolated plugin Node runtime is unsupported.");
    const active = new Set<Promise<unknown>>();
    let closed = false;
    const invoke: IsolatedPluginRuntime["invoke"] = async (operation) => {
      if (closed) throw new Error("The isolated plugin runtime is closed.");
      if (active.size >= 4) throw new Error("The isolated plugin runtime is busy.");
      const run = (async () => {
        const directory = await NodeFSP.mkdtemp(NodePath.join(root, "invoke-"));
        try {
          const pluginPath = NodePath.join(directory, "plugin.mjs");
          await NodeFSP.writeFile(pluginPath, operation.artifact.entryBytes, {
            mode: 0o400,
            flag: "wx",
          });
          const policy = NodePath.join(directory, "policy.sb");
          const quote = JSON.stringify;
          await NodeFSP.writeFile(
            policy,
            `(version 1)
(deny default)
(import "dyld-support.sb")
(allow syscall*)
(allow mach-bootstrap)
(allow signal (target self))
(allow sysctl-read)
(allow process-exec (literal ${quote(runtime)}))
(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (literal ${quote(runtime)}) (literal ${quote(bootstrap)}) (literal ${quote(engine)}) (literal ${quote(bridge)}) (literal ${quote(pluginPath)}))
(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib") (literal ${quote(runtime)}))
(allow file-read-metadata file-test-existence (path-ancestors ${quote(runtime)}) (path-ancestors ${quote(bootstrap)}) (path-ancestors ${quote(engine)}) (path-ancestors ${quote(bridge)}) (path-ancestors ${quote(pluginPath)}))
`,
            { mode: 0o400, flag: "wx" },
          );
          return await runMacPluginWorker({
            ...operation,
            pluginPath,
            launch: {
              platform: input.platform,
              supervisor,
              runtime,
              bootstrap,
              policy,
              cwd: directory,
              cpuSeconds: 2,
              wallMs: 30_000,
            },
          });
        } finally {
          await NodeFSP.rm(directory, { recursive: true, force: true });
        }
      })();
      active.add(run);
      try {
        return await run;
      } finally {
        active.delete(run);
      }
    };
    return {
      executionProfile: QUICKJS_EXECUTION_PROFILE,
      workerNodeVersion: version,
      invoke,
      async [Symbol.asyncDispose]() {
        closed = true;
        await Promise.allSettled(active);
        await NodeFSP.rm(root, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw cause;
  }
}
