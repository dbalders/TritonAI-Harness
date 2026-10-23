import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import type { ProcessRunner, ProcessRunOutput } from "../processRunner.ts";
import { ManagedCodexApprovedVersion, updateTritonAiManagedCodex } from "./managedCodexUpdate.ts";
import { ManagedCodexLockError } from "./managedCodexLock.ts";

const hooks = vi.hoisted(() => ({
  compromise: undefined as ((cause: Error) => void) | undefined,
  release: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return {
    ...actual,
    lock: async (...args: Parameters<typeof actual.lock>) => {
      const release = await actual.lock(...args);
      hooks.compromise = args[1]?.onCompromised;
      hooks.release = release;
      return release;
    },
  };
});

const success = (version = ""): ProcessRunOutput => ({
  stdout: version ? `codex-cli ${version}` : "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

it.layer(NodeServices.layer)("managed Codex activation ownership", (it) => {
  it.effect.each(["compromised heartbeat", "replacement before heartbeat"])(
    "preserves a peer engine after %s",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "codex-lock-test-" });
        const runtimeRoot = path.join(home, ".agents", "ucsd", "runtime", "codex");
        const installRoot = path.join(runtimeRoot, "openai-codex-0.146.0");
        const binaryPath = path.join(installRoot, "bin", "codex");
        const versionFile = path.join(installRoot, "version.txt");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "managed launcher");
        yield* fs.writeFileString(versionFile, "0.146.0");
        let takeover = false;
        const run: ProcessRunner["Service"]["run"] = (input) =>
          Effect.gen(function* () {
            if (input.command === "npm") {
              const prefix = input.args[input.args.indexOf("--prefix") + 1]!;
              yield* fs.makeDirectory(path.join(prefix, "bin"), { recursive: true });
              yield* fs.writeFileString(path.join(prefix, "bin", "codex"), "generated launcher");
              yield* fs.writeFileString(path.join(prefix, "version.txt"), "0.151.0");
              return success();
            }
            const version = yield* fs.readFileString(
              path.join(path.dirname(path.dirname(input.command)), "version.txt"),
            );
            if (input.command === binaryPath && version === "0.151.0" && !takeover) {
              takeover = true;
              yield* fs.writeFileString(versionFile, "0.160.0");
              if (scenario === "compromised heartbeat") {
                hooks.compromise?.(new Error("test lease takeover"));
                return yield* Effect.never;
              }
              // Retain the original directory so inode reuse cannot make this fixture ambiguous.
              yield* fs.rename(`${runtimeRoot}.lock`, `${runtimeRoot}.retired-lock`);
              yield* fs.makeDirectory(`${runtimeRoot}.lock`);
            }
            return success(version);
          }).pipe(Effect.orDie);
        yield* updateTritonAiManagedCodex({ binaryPath, run }).pipe(
          Effect.provideService(ManagedCodexApprovedVersion, "0.151.0"),
          Effect.scoped,
          Effect.exit,
        );
        expect(takeover).toBe(true);
        expect(yield* fs.readFileString(versionFile)).toBe("0.160.0");
        const backup = (yield* fs.readDirectory(runtimeRoot)).find((entry) =>
          entry.startsWith(".tritonai-codex-backup."),
        );
        expect(backup).toBeDefined();
        expect(
          yield* fs.readFileString(
            path.join(runtimeRoot, backup!, "openai-codex-0.146.0", "version.txt"),
          ),
        ).toBe("0.146.0");
        if (scenario === "replacement before heartbeat")
          expect(yield* fs.exists(`${runtimeRoot}.lock`)).toBe(true);
        yield* Effect.tryPromise({
          try: () => hooks.release?.() ?? Promise.resolve(),
          catch: () =>
            new ManagedCodexLockError({ message: "The test lock was already released." }),
        }).pipe(Effect.ignore);
      }).pipe(Effect.scoped),
  );
});
