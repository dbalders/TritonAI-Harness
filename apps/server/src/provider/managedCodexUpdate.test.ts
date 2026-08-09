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
  makeTritonAiManagedCodexMaintenanceResolver,
  parseCodexCliVersion,
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
});

const failure = (stderr: string): ProcessRunOutput => ({
  stdout: "",
  stderr,
  code: ChildProcessSpawner.ExitCode(1),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
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
        if (options?.failNpm) return failure("npm failed");
        const prefixIndex = input.args.indexOf("--prefix");
        const prefix = input.args[prefixIndex + 1];
        if (!prefix) return failure("missing prefix");
        const stagedBinary = path.join(prefix, "bin", "codex");
        yield* fs.makeDirectory(path.dirname(stagedBinary), { recursive: true });
        yield* fs.writeFileString(stagedBinary, "#!/usr/bin/env node\n");
        yield* fs.chmod(stagedBinary, 0o755);
        yield* fs.writeFileString(path.join(prefix, "version.txt"), "0.147.0");
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
        version.trim() === "0.147.0"
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
  expect(parseCodexCliVersion("codex-cli 0.147.0\n")).toBe("0.147.0");
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

      expect(version).toBe("0.147.0");
      expect(yield* fixture.fs.readFileString(fixture.binaryPath)).toContain("managed launcher");
      expect(
        yield* fixture.fs.readFileString(fixture.path.join(fixture.installRoot, "version.txt")),
      ).toBe("0.147.0");
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
