import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as PlatformError from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ProcessRunOutput, ProcessRunner } from "../processRunner.ts";
import {
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceResolutionContext,
  normalizeCommandPath,
} from "./providerMaintenance.ts";
import {
  isTritonAiManagedCodexMaintenanceCapabilities,
  makeTritonAiManagedCodexMaintenanceResolver,
  parseCodexCliVersion,
  ManagedCodexApprovedVersion,
  resolveTritonAiManagedCodexInstallation,
  updateTritonAiManagedCodex,
} from "./managedCodexUpdate.ts";

const success = (stdout = ""): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const failure = (stderr: string): ProcessRunOutput => ({
  stdout: "",
  stderr,
  code: ChildProcessSpawner.ExitCode(1),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const makeFixture = Effect.fn("managedCodexUpdate.test.makeFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "managed-codex-update-test-" });
  const runtimeRoot = path.join(root, ".agents", "ucsd", "runtime", "codex");
  const installRoot = path.join(runtimeRoot, "openai-codex-0.146.0");
  const binaryPath = path.join(installRoot, "bin", "codex");
  yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
  yield* fs.writeFileString(binaryPath, "#!/usr/bin/env sh\n# managed launcher\n");
  yield* fs.chmod(binaryPath, 0o755);
  yield* fs.writeFileString(path.join(installRoot, "version.txt"), "0.146.0");
  return { fs, path, runtimeRoot, installRoot, binaryPath };
});

const makeFakeRunner = Effect.fn("managedCodexUpdate.test.makeFakeRunner")(function* (options?: {
  readonly failNpm?: boolean;
  readonly failActivatedVerification?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run: ProcessRunner["Service"]["run"] = (input) =>
    Effect.gen(function* () {
      if (input.command === "npm") {
        expect(input.args.some((arg) => /^@openai\/codex@0\.15[12]\.0$/.test(arg))).toBe(true);
        expect(input.args).not.toContain("@openai/codex@latest");
        if (options?.failNpm) return failure("npm failed");
        const prefixIndex = input.args.indexOf("--prefix");
        const prefix = input.args[prefixIndex + 1];
        if (!prefix) return failure("missing prefix");
        const stagedBinary = path.join(prefix, "bin", "codex");
        yield* fs.makeDirectory(path.dirname(stagedBinary), { recursive: true });
        yield* fs.writeFileString(stagedBinary, "#!/usr/bin/env node\n");
        yield* fs.chmod(stagedBinary, 0o755);
        yield* fs.writeFileString(path.join(prefix, "version.txt"), "0.151.0");
        return success("installed");
      }

      if (!normalizeCommandPath(input.command).endsWith("/bin/codex")) {
        return failure("unexpected command");
      }
      const commandInstallRoot = path.dirname(path.dirname(input.command));
      const version = yield* fs.readFileString(path.join(commandInstallRoot, "version.txt"));
      if (
        options?.failActivatedVerification &&
        !normalizeCommandPath(input.command).includes("/.tritonai-codex-stage.") &&
        version.trim() === "0.151.0"
      ) {
        return failure("active verification failed");
      }
      return success(`codex-cli ${version.trim()}`);
    }).pipe(Effect.orDie);
  return run;
});

it("recognizes only TritonAI managed Codex launcher paths", () => {
  expect(
    resolveTritonAiManagedCodexInstallation(
      "/Users/test/.agents/ucsd/runtime/codex/openai-codex-0.146.0/bin/codex",
    ),
  ).toEqual({
    binaryPath: "/Users/test/.agents/ucsd/runtime/codex/openai-codex-0.146.0/bin/codex",
    installRoot: "/Users/test/.agents/ucsd/runtime/codex/openai-codex-0.146.0",
    binaryRelativeSegments: ["bin", "codex"],
    windows: false,
  });
  expect(
    resolveTritonAiManagedCodexInstallation(
      "C:\\Users\\test\\.agents\\ucsd\\runtime\\codex\\openai-codex-0.146.0\\codex.cmd",
    ),
  ).toMatchObject({
    installRoot: "C:\\Users\\test\\.agents\\ucsd\\runtime\\codex\\openai-codex-0.146.0",
    binaryRelativeSegments: ["codex.cmd"],
    windows: true,
  });
  expect(resolveTritonAiManagedCodexInstallation("/opt/homebrew/bin/codex")).toBeNull();
  expect(
    resolveTritonAiManagedCodexInstallation(
      "/Users/test/.agents/ucsd/runtime/codex/not-managed/bin/codex",
    ),
  ).toBeNull();
});

it("parses Codex CLI version output", () => {
  expect(parseCodexCliVersion("codex-cli 0.151.0\n")).toBe("0.151.0");
  expect(parseCodexCliVersion("not a version")).toBeNull();
});

it.effect(
  "routes managed launchers through the Harness updater and preserves parent fallback",
  () =>
    Effect.gen(function* () {
      const provider = ProviderDriverKind.make("codex");
      const fallbackCapabilities = makeProviderMaintenanceCapabilities({
        provider,
        packageName: "@openai/codex",
        updateExecutable: "brew",
        updateArgs: ["upgrade", "codex"],
        updateLockKey: "homebrew-codex",
      });
      const fallbackContexts: Array<ProviderMaintenanceResolutionContext | null> = [];
      const resolver = makeTritonAiManagedCodexMaintenanceResolver({
        provider,
        packageName: "@openai/codex",
        fallback: {
          resolve: (context) =>
            Effect.sync(() => {
              fallbackContexts.push(context);
              return fallbackCapabilities;
            }),
        },
        executablePath: "/Applications/TritonAI Harness.app/Contents/MacOS/TritonAI Harness",
        serverEntryPath: "/app/apps/server/dist/bin.mjs",
      });
      const binaryPath = "/Users/test/.agents/ucsd/runtime/codex/openai-codex-0.146.0/bin/codex";
      const context: ProviderMaintenanceResolutionContext = {
        binaryPath,
        resolvedCommandPath: binaryPath,
        realCommandPath: binaryPath,
        env: {},
        platform: "darwin",
      };
      expect((yield* resolver.resolve(context)).update).toMatchObject({
        executable: "/Applications/TritonAI Harness.app/Contents/MacOS/TritonAI Harness",
        args: ["/app/apps/server/dist/bin.mjs", "managed-codex-update", binaryPath],
        lockKey: "tritonai-managed-codex",
      });
      const aliasResolution = yield* resolver.resolve({ ...context, binaryPath: "codex" });
      expect(isTritonAiManagedCodexMaintenanceCapabilities(aliasResolution)).toBe(true);
      expect(fallbackContexts).toEqual([]);
      const homebrewContext = {
        ...context,
        binaryPath: "/opt/homebrew/bin/codex",
        resolvedCommandPath: "/opt/homebrew/bin/codex",
        realCommandPath: "/opt/homebrew/Cellar/codex/0.151.0/bin/codex",
      };
      expect(yield* resolver.resolve(homebrewContext)).toBe(fallbackCapabilities);
      expect(fallbackContexts).toEqual([homebrewContext]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.layer(NodeServices.layer)("managed Codex update transaction", (it) => {
  it.effect("stages, verifies, atomically activates, and retains the managed launcher", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const version = yield* updateTritonAiManagedCodex({
        binaryPath: fixture.binaryPath,
        run: yield* makeFakeRunner(),
      }).pipe(Effect.scoped);

      expect(version).toBe("0.151.0");
      expect(yield* fixture.fs.readFileString(fixture.binaryPath)).toContain("managed launcher");
      expect(
        yield* fixture.fs.readFileString(fixture.path.join(fixture.installRoot, "version.txt")),
      ).toBe("0.151.0");
      expect((yield* fixture.fs.readDirectory(fixture.runtimeRoot)).toSorted()).toEqual([
        "openai-codex-0.146.0",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("rolls back when the activated runtime fails verification", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const error = yield* updateTritonAiManagedCodex({
        binaryPath: fixture.binaryPath,
        run: yield* makeFakeRunner({ failActivatedVerification: true }),
      }).pipe(Effect.scoped, Effect.flip);

      expect(error.message).toContain("rolled back");
      expect(yield* fixture.fs.readFileString(fixture.binaryPath)).toContain("managed launcher");
      expect(
        yield* fixture.fs.readFileString(fixture.path.join(fixture.installRoot, "version.txt")),
      ).toBe("0.146.0");
      expect((yield* fixture.fs.readDirectory(fixture.runtimeRoot)).toSorted()).toEqual([
        "openai-codex-0.146.0",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the current runtime unchanged when npm staging fails", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const error = yield* updateTritonAiManagedCodex({
        binaryPath: fixture.binaryPath,
        run: yield* makeFakeRunner({ failNpm: true }),
      }).pipe(Effect.scoped, Effect.flip);

      expect(error.message).toContain("could not be staged");
      expect(
        yield* fixture.fs.readFileString(fixture.path.join(fixture.installRoot, "version.txt")),
      ).toBe("0.146.0");
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("approved managed engine policy", (it) => {
  for (const installed of ["0.151.0", "0.155.1"]) {
    it.effect(`rejects direct updates from ${installed} without running npm`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        yield* fixture.fs.writeFileString(
          fixture.path.join(fixture.installRoot, "version.txt"),
          installed,
        );
        const error = yield* updateTritonAiManagedCodex({
          binaryPath: fixture.binaryPath,
          run: (input) => {
            expect(input.command).not.toBe("npm");
            return Effect.succeed(success(`codex-cli ${installed}`));
          },
        }).pipe(Effect.flip);
        expect(error.message).toContain("meets or exceeds");
        expect(yield* fixture.fs.readDirectory(fixture.runtimeRoot)).toEqual([
          "openai-codex-0.146.0",
        ]);
      }).pipe(Effect.scoped),
    );
  }
  for (const approved of [null, "latest", "0.155.1 || true"]) {
    it.effect(`fails closed for policy ${String(approved)}`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const error = yield* updateTritonAiManagedCodex({
          binaryPath: fixture.binaryPath,
          run: () => Effect.die("must not run a command"),
        }).pipe(Effect.provideService(ManagedCodexApprovedVersion, approved), Effect.flip);
        expect(error.message).toContain("No valid approved");
      }).pipe(Effect.scoped),
    );
  }
  it.effect("rejects a staged package that differs from the approved pin", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const error = yield* updateTritonAiManagedCodex({
        binaryPath: fixture.binaryPath,
        run: yield* makeFakeRunner(),
      }).pipe(Effect.provideService(ManagedCodexApprovedVersion, "0.152.0"), Effect.flip);
      expect(error.message).toContain("approved version");
      expect(
        yield* fixture.fs.readFileString(fixture.path.join(fixture.installRoot, "version.txt")),
      ).toBe("0.146.0");
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("Windows managed engine updates", (it) => {
  for (const layout of ["lib\\node_modules", "node_modules"]) {
    for (const scenario of [
      "success",
      "verification failure",
      "temporary lock",
      "persistent lock",
      "unrelated error",
      "rollback removal lock",
      "rollback restoration lock",
    ]) {
      const rollbackFailure = scenario.startsWith("rollback");
      const failActivation = scenario === "verification failure" || rollbackFailure;
      const shouldFail = scenario !== "success" && scenario !== "temporary lock";
      it.effect(`${layout}: ${scenario}`, () =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture();
          const { fs, path, installRoot, runtimeRoot } = fixture;
          const binaryPath = path.join(installRoot, "codex.cmd");
          const nodeHome = path.join(path.dirname(runtimeRoot), "node", "node-v22.23.2-win-x64");
          const nodeBinary = path.join(nodeHome, "node.exe");
          const npmCli = path.join(nodeHome, "node_modules", "npm", "bin", "npm-cli.js");
          const entrySegments = [...layout.split("\\"), "@openai", "codex", "bin", "codex.js"];
          const launcher = [
            "@echo off",
            "setlocal",
            'set "SCRIPT_DIR=%~dp0"',
            'set "NODE_BIN=%SCRIPT_DIR%..\\..\\node\\node-v22.23.2-win-x64\\node.exe"',
            `"%NODE_BIN%" "%SCRIPT_DIR%${entrySegments.join("\\")}" %*`,
            "",
          ].join("\r\n");
          yield* fs.writeFileString(binaryPath, launcher);
          yield* fs.makeDirectory(path.dirname(npmCli), { recursive: true });
          yield* fs.writeFileString(nodeBinary, "managed Node");
          yield* fs.writeFileString(npmCli, "managed npm");
          const activeEntry = path.join(installRoot, ...entrySegments);
          yield* fs.makeDirectory(path.dirname(activeEntry), { recursive: true });
          yield* fs.writeFileString(activeEntry, "0.146.0");
          let installs = 0;
          const run: ProcessRunner["Service"]["run"] = (input) =>
            Effect.gen(function* () {
              if (input.command === binaryPath) {
                const version = yield* fs.readFileString(activeEntry);
                if (failActivation && version === "0.151.0") return failure("activation failed");
                expect(yield* fs.readFileString(binaryPath)).toBe(launcher);
                return success(`codex-cli ${version}`);
              }
              // Neither npm.cmd nor the generated staged shim may depend on PATH.
              expect(input.command).toBe(nodeBinary);
              if (input.args[0] === npmCli) {
                installs++;
                expect(input.args).toContain("@openai/codex@0.151.0");
                const prefix = input.args[input.args.indexOf("--prefix") + 1]!;
                const entry = path.join(
                  prefix,
                  "node_modules",
                  "@openai",
                  "codex",
                  "bin",
                  "codex.js",
                );
                yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
                yield* fs.writeFileString(entry, "0.151.0");
                yield* fs.writeFileString(path.join(prefix, "codex.cmd"), "ambient node shim");
                return success();
              }
              expect(input.args[1]).toBe("--version");
              return success(`codex-cli ${yield* fs.readFileString(input.args[0]!)}`);
            }).pipe(Effect.orDie);
          const lockObserved = yield* Deferred.make<void>();
          let activationAttempts = 0;
          const testFs = FileSystem.FileSystem.of({
            ...fs,
            rename: (source, destination) =>
              Effect.gen(function* () {
                if (
                  scenario === "rollback restoration lock" &&
                  source.includes(".tritonai-codex-backup.")
                ) {
                  yield* Deferred.succeed(lockObserved, undefined);
                  return yield* PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "rename",
                    cause: Object.assign(new Error("locked backup"), { code: "EPERM" }),
                  });
                }
                if (source.includes(".tritonai-codex-stage.") && destination === installRoot) {
                  activationAttempts++;
                  if (
                    scenario === "persistent lock" ||
                    scenario === "unrelated error" ||
                    (scenario === "temporary lock" && activationAttempts === 1)
                  ) {
                    yield* Deferred.succeed(lockObserved, undefined);
                    return yield* PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "rename",
                      cause: Object.assign(new Error("file operation failed"), {
                        code: scenario === "unrelated error" ? "ENOENT" : "EPERM",
                      }),
                    });
                  }
                }
                return yield* fs.rename(source, destination);
              }),
            remove: (target, options) =>
              Effect.gen(function* () {
                if (scenario === "rollback removal lock" && target === installRoot) {
                  yield* Deferred.succeed(lockObserved, undefined);
                  return yield* PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "remove",
                    cause: Object.assign(new Error("locked active engine"), { code: "EPERM" }),
                  });
                }
                return yield* fs.remove(target, options);
              }),
          });
          const fiber = yield* updateTritonAiManagedCodex({ binaryPath, run }).pipe(
            Effect.provideService(FileSystem.FileSystem, testFs),
            Effect.scoped,
            Effect.result,
            Effect.forkChild,
          );
          if (scenario.includes("lock")) {
            yield* Deferred.await(lockObserved);
            yield* TestClock.adjust("11 seconds");
          }
          const result = yield* Fiber.join(fiber);
          expect(activationAttempts).toBe(
            scenario === "persistent lock" ? 41 : scenario === "temporary lock" ? 2 : 1,
          );
          expect(installs).toBe(1);
          expect(result._tag).toBe(shouldFail ? "Failure" : "Success");
          if (rollbackFailure) {
            const entries = yield* fs.readDirectory(runtimeRoot);
            const backup = entries.find((entry) => entry.startsWith(".tritonai-codex-backup."));
            expect(backup).toBeDefined();
            const savedRoot = path.join(runtimeRoot, backup!, "openai-codex-0.146.0");
            expect(yield* fs.readFileString(path.join(savedRoot, ...entrySegments))).toBe(
              "0.146.0",
            );
            expect(yield* fs.readFileString(path.join(savedRoot, "codex.cmd"))).toBe(launcher);
            if (result._tag === "Failure") expect(result.failure.message).toContain(savedRoot);
          } else {
            expect(yield* fs.readFileString(activeEntry)).toBe(shouldFail ? "0.146.0" : "0.151.0");
            expect(yield* fs.readFileString(binaryPath)).toBe(launcher);
            expect(yield* fs.readDirectory(runtimeRoot)).toEqual(["openai-codex-0.146.0"]);
          }
        }).pipe(Effect.scoped),
      );
    }
  }
});
