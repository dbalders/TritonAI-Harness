import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ProcessRunOutput, ProcessRunner } from "../processRunner.ts";
import {
  makePackageManagedProviderMaintenanceResolver,
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

it("routes managed launchers through the Harness updater and preserves parent fallback", () => {
  const provider = ProviderDriverKind.make("codex");
  const fallback = makePackageManagedProviderMaintenanceResolver({
    provider,
    npmPackageName: "@openai/codex",
    homebrewFormula: "codex",
    nativeUpdate: null,
  });
  const resolver = makeTritonAiManagedCodexMaintenanceResolver({
    provider,
    packageName: "@openai/codex",
    fallback,
    executablePath: "/Applications/TritonAI Harness.app/Contents/MacOS/TritonAI Harness",
    serverEntryPath: "/app/apps/server/dist/bin.mjs",
  });
  const binaryPath = "/Users/test/.agents/ucsd/runtime/codex/openai-codex-0.146.0/bin/codex";

  expect(resolver.resolve({ binaryPath }).update).toMatchObject({
    executable: "/Applications/TritonAI Harness.app/Contents/MacOS/TritonAI Harness",
    args: ["/app/apps/server/dist/bin.mjs", "managed-codex-update", binaryPath],
    lockKey: "tritonai-managed-codex",
  });
  const aliasResolution = resolver.resolve({
    binaryPath: "codex",
    resolvedCommandPath: binaryPath,
  });
  expect(isTritonAiManagedCodexMaintenanceCapabilities(aliasResolution)).toBe(true);
  expect(resolver.resolve({ binaryPath: "/opt/homebrew/bin/codex" }).update).toMatchObject({
    executable: "brew",
    args: ["upgrade", "codex"],
  });
});

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
