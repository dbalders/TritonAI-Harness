import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const spawnError = (reason: "NotFound" | "PermissionDenied", module = "ChildProcess") =>
  new VcsProcessSpawnError({
    operation: "GitVcsDriver.isInsideWorkTree",
    command: "git",
    cwd: "/repo",
    cause: PlatformError.systemError({
      _tag: reason,
      module,
      method: module === "ChildProcess" ? "spawn" : "access",
      pathOrDescriptor: module === "ChildProcess" ? "git -C /repo rev-parse" : "/missing-cwd",
    }),
  });

const withProcess = (run: VcsProcess.VcsProcess["Service"]["run"]) =>
  Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(VcsProcess.VcsProcess, { run })));

describe("optional Git detection", () => {
  it.effect("returns false/null when the Git executable is missing", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      assert.isFalse(yield* driver.isInsideWorkTree("/repo"));
      assert.isNull(yield* driver.detectRepository("/repo"));
      assert.instanceOf(
        yield* driver
          .execute({ operation: "test", cwd: "/repo", args: ["init"] })
          .pipe(Effect.flip),
        VcsProcessSpawnError,
      );
    }).pipe(
      withProcess(() => Effect.fail(spawnError("NotFound"))),
      Effect.provideService(HostProcessPlatform, "win32"),
    ),
  );

  for (const error of [
    spawnError("PermissionDenied"),
    spawnError("NotFound", "FileSystem"),
    new VcsProcessTimeoutError({
      operation: "test",
      command: "git",
      cwd: "/repo",
      timeoutMs: 5000,
    }),
  ]) {
    it.effect(`preserves ${error._tag}: ${error.message}`, () =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        assert.strictEqual(yield* driver.isInsideWorkTree("/repo").pipe(Effect.flip), error);
      }).pipe(
        withProcess(() => Effect.fail(error)),
        Effect.provideService(HostProcessPlatform, "win32"),
      ),
    );
  }

  it.effect("detects Git installed after an earlier missing-Git probe", () => {
    let available = false;
    return Effect.gen(function* () {
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      assert.isFalse(yield* driver.isInsideWorkTree("/repo"));
      available = true;
      assert.isTrue(yield* driver.isInsideWorkTree("/repo"));
    }).pipe(
      withProcess(() =>
        available ? Effect.succeed(output("true\n")) : Effect.fail(spawnError("NotFound")),
      ),
      Effect.provideService(HostProcessPlatform, "win32"),
    );
  });
});

describe("Apple Git detection", () => {
  it.effect("preserves unexpected developer-tools check failures without launching Git", () => {
    const error = new VcsProcessExitError({
      operation: "test",
      command: "/usr/bin/xcode-select",
      cwd: "/repo",
      exitCode: 1,
      detail: "unexpected failure",
    });
    return Effect.gen(function* () {
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      assert.strictEqual(yield* driver.isInsideWorkTree("/repo").pipe(Effect.flip), error);
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ realPath: () => Effect.succeed("/usr/bin/git") }),
      ),
      withProcess((input) => {
        assert.strictEqual(input.command, "/usr/bin/xcode-select");
        return Effect.fail(error);
      }),
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(HostProcessEnvironment, {}),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) => {
        assert.strictEqual(env.PATH, "/usr/bin:/bin");
        return "/usr/bin/git";
      }),
    );
  });

  for (const gitPath of ["/usr/bin/git", "/custom/git-link"]) {
    it.effect(`does not launch the developer-tools stub resolved from ${gitPath}`, () => {
      const commands: string[] = [];
      return Effect.gen(function* () {
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        assert.isFalse(yield* driver.isInsideWorkTree("/repo"));
        assert.deepStrictEqual(commands, ["/usr/bin/xcode-select"]);
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ realPath: () => Effect.succeed("/usr/bin/git") }),
        ),
        withProcess((input) => {
          commands.push(input.command);
          return input.command === "/usr/bin/xcode-select"
            ? Effect.fail(
                new VcsProcessExitError({
                  ...input,
                  exitCode: 2,
                  detail: "no developer directory",
                  stderrTruncated: false,
                  failureKind: "command-failed",
                }),
              )
            : Effect.succeed(output("true\n"));
        }),
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(SpawnExecutableResolution, () => gitPath),
      );
    });
  }

  it.effect("probes Apple Git when developer tools are available", () => {
    const commands: string[] = [];
    return Effect.gen(function* () {
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      assert.isTrue(yield* driver.isInsideWorkTree("/repo"));
      assert.deepStrictEqual(commands, ["/usr/bin/xcode-select", "git"]);
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ realPath: () => Effect.succeed("/usr/bin/git") }),
      ),
      withProcess((input) => {
        commands.push(input.command);
        return Effect.succeed(output("true\n"));
      }),
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(SpawnExecutableResolution, () => "/usr/bin/git"),
    );
  });

  it.effect("uses custom Git without requiring Apple developer tools", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      assert.isTrue(yield* driver.isInsideWorkTree("/repo"));
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({ realPath: () => Effect.succeed("/custom/bin/git") }),
      ),
      withProcess((input) => {
        assert.strictEqual(input.command, "git");
        return Effect.succeed(output("true\n"));
      }),
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(HostProcessEnvironment, { PATH: "/custom/bin" }),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, env) => {
        assert.strictEqual(env.PATH, "/custom/bin");
        return "/custom/bin/git";
      }),
    ),
  );
});
