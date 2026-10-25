import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";
import {
  Environment as HostProcessEnvironment,
  Platform as HostProcessPlatform,
} from "@t3tools/shared/HostProcess";
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
  // regression: #327 fix(server): skip repository probes when Git is unavailable
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

  // regression: #327 fix(server): skip repository probes when Git is unavailable
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
  // regression: #327 fix(server): skip repository probes when Git is unavailable
  describe.each(Array.from(["/usr/bin/git", "/custom/git-link"], (scenario) => ({ scenario })))(
    "case $scenario",
    ({ scenario: gitPath }) => {
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
    },
  );

  // regression: #327 fix(server): skip repository probes when Git is unavailable
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
