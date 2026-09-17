import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HostProcessPlatform,
  HostProcessExecutablePath,
  HostProcessEnvironment,
} from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunnerModule from "../processRunner.ts";
import {
  ProcessSpawnError,
  type ProcessRunInput,
  type ProcessRunOutput,
  type ProcessRunner,
} from "../processRunner.ts";
import { resolveManagedCodexBinary } from "./managedCodexRuntime.ts";
import { materializeTritonAiCodexModelCatalog } from "./Drivers/CodexModelCatalog.ts";
const encodePackage = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
);

const output = (version: string, code = 0): ProcessRunOutput => ({
  stdout: version ? `codex-cli ${version}\n` : "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const fixture = Effect.fn("managedCodexRuntime.test.fixture")(function* (
  platform: NodeJS.Platform = "darwin",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "codex runtime test " });
  const runtimeRoot = path.join(homeDirectory, ".agents", "ucsd", "runtime", "codex");
  const versions = new Map<string, ProcessRunOutput>();
  const calls: ProcessRunInput[] = [];
  const environment = {
    PATH: "/usr/bin:/bin",
    CODEX_HOME: path.join(homeDirectory, "nightly", "codex"),
  };
  const run: ProcessRunner["Service"]["run"] = (input) => {
    calls.push(input);
    const result = versions.get(input.command);
    return result
      ? Effect.succeed(result)
      : Effect.fail(
          new ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: new Error("ENOENT"),
          }),
        );
  };
  const install = Effect.fn("managedCodexRuntime.test.install")(function* (
    directoryVersion: string,
    version = directoryVersion,
    name = "@openai/codex",
  ) {
    const installRoot = path.join(runtimeRoot, `openai-codex-${directoryVersion}`);
    const binaryPath =
      platform === "win32"
        ? path.join(installRoot, "codex.cmd")
        : path.join(installRoot, "bin", "codex");
    const packageRoot = path.join(installRoot, "lib", "node_modules", "@openai", "codex");
    yield* fs.makeDirectory(packageRoot, { recursive: true });
    yield* fs.writeFileString(
      path.join(packageRoot, "package.json"),
      encodePackage({ name, version }),
    );
    versions.set(binaryPath, output(version));
    return { binaryPath, packageRoot };
  });
  const resolve = (binaryPath = "codex") =>
    resolveManagedCodexBinary({ binaryPath, homeDirectory, platform, environment, run });
  return { fs, path, homeDirectory, runtimeRoot, versions, calls, environment, install, resolve };
});

it.layer(NodeServices.layer)("managed Codex runtime discovery", (it) => {
  it.effect("boots a fresh profile with no settings and no codex on PATH", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const installed = yield* f.install("0.146.0");
      assert.equal(yield* f.resolve(), installed.binaryPath);
      assert.isFalse(yield* f.fs.exists(f.path.join(f.homeDirectory, ".tritonai-harness")));
      assert.equal(f.calls.length, 2);
      assert.deepEqual(f.calls[1]?.env, f.environment);
      assert.deepEqual(f.calls[1]?.args, ["--version"]);
    }),
  );

  it.effect("keeps a working command on PATH even when a newer managed runtime exists", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.install("0.150.0");
      f.versions.set("codex", output("0.146.0"));
      assert.equal(yield* f.resolve(), "codex");
      assert.equal(f.calls.length, 1);
    }),
  );

  it.effect("preserves an explicit working managed runtime", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const pinned = yield* f.install("0.146.0");
      yield* f.install("0.150.0");
      assert.equal(yield* f.resolve(pinned.binaryPath), pinned.binaryPath);
      assert.equal(f.calls.length, 1);
    }),
  );

  it.effect("recovers a removed managed runtime using an installed version", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const old = yield* f.install("0.146.0");
      f.versions.delete(old.binaryPath);
      const replacement = yield* f.install("0.150.0");
      assert.equal(yield* f.resolve(old.binaryPath), replacement.binaryPath);
    }),
  );

  it.effect("sorts by installed package versions after an in-place engine update", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.install("0.99.0");
      const upgraded = yield* f.install("0.146.0", "0.151.0");
      yield* f.install("0.150.0");
      assert.equal(yield* f.resolve(), upgraded.binaryPath);
    }),
  );

  it.effect("skips incomplete, incompatible, hung and mismatched runtimes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const good = yield* f.install("0.146.0");
      const missing = yield* f.install("0.150.0");
      f.versions.delete(missing.binaryPath);
      const incompatible = yield* f.install("0.151.0");
      f.versions.set(incompatible.binaryPath, output("", 126));
      const hung = yield* f.install("0.152.0");
      f.versions.set(hung.binaryPath, { ...output(""), timedOut: true });
      const mismatched = yield* f.install("0.153.0");
      f.versions.set(mismatched.binaryPath, output("0.145.0"));
      assert.equal(yield* f.resolve(), good.binaryPath);
    }),
  );

  it.effect("ignores malformed packages and transactional staging directories", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const good = yield* f.install("0.146.0");
      const invalid = yield* f.install("0.150.0");
      yield* f.fs.writeFileString(f.path.join(invalid.packageRoot, "package.json"), "{");
      const unrelated = yield* f.install("0.151.0", "0.151.0", "unrelated");
      const staged = yield* f.install("0.152.0");
      yield* f.fs.rename(
        f.path.dirname(f.path.dirname(staged.binaryPath)),
        f.path.join(f.runtimeRoot, ".tritonai-codex-stage.test"),
      );
      assert.equal(yield* f.resolve(), good.binaryPath);
      assert.deepEqual(
        f.calls.map((call) => call.command),
        ["codex", good.binaryPath],
      );
      assert.isFalse(f.calls.some((call) => call.command === unrelated.binaryPath));
    }),
  );

  it.effect("leaves custom commands alone, including broken ones", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.install("0.146.0");
      for (const command of [
        "/custom/codex",
        "codex-dev",
        "/Applications/Codex.app/Contents/Resources/codex",
      ]) {
        assert.equal(yield* f.resolve(command), command);
      }
      assert.equal(f.calls.length, 0);
    }),
  );

  it.effect("treats an empty path like the default command", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const installed = yield* f.install("0.146.0");
      assert.equal(yield* f.resolve("  "), installed.binaryPath);
    }),
  );

  it.effect("reports an actionable failure when no runtime can start", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const error = yield* Effect.flip(f.resolve());
      assert.include(error.message, "Run TritonAI Installer");
      assert.include(error.message, "'codex'");
      assert.isFalse(yield* f.fs.exists(f.runtimeRoot));
    }),
  );

  it.effect("resolves Windows launchers with both bundled and npm package layouts", () =>
    Effect.gen(function* () {
      const f = yield* fixture("win32");
      const bundled = yield* f.install("0.146.0");
      assert.equal(yield* f.resolve(), bundled.binaryPath);
      const npm = yield* f.install("0.150.0");
      const installRoot = f.path.dirname(npm.binaryPath);
      yield* f.fs.rename(
        f.path.join(installRoot, "lib", "node_modules"),
        f.path.join(installRoot, "node_modules"),
      );
      assert.equal(yield* f.resolve(), npm.binaryPath);
    }),
  );

  it.effect("launches the discovered runtime to materialize a new profile's model catalog", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const executable = yield* HostProcessExecutablePath;
      const hostEnvironment = yield* HostProcessEnvironment;
      const f = yield* fixture(platform);
      const installed = yield* f.install("0.146.0");
      const script = f.path.join(f.homeDirectory, "codex-fixture.cjs");
      yield* f.fs.writeFileString(
        script,
        `
const version = process.argv[2] === '--version';
if (!version && process.argv.slice(2).join(' ') !== 'debug models --bundled') process.exit(1);
console.log(version ? 'codex-cli 0.146.0' : JSON.stringify({ models: [{
  slug: 'gpt-5.2', base_instructions: 'Test instructions', input_modalities: ['text', 'image']
}] }));
`,
      );
      yield* f.fs.makeDirectory(f.path.dirname(installed.binaryPath), { recursive: true });
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const launcher =
        platform === "win32"
          ? `@echo off\r\n"${executable}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec ${quote(executable)} ${quote(script)} "$@"\n`;
      yield* f.fs.writeFileString(installed.binaryPath, launcher);
      if (platform !== "win32") yield* f.fs.chmod(installed.binaryPath, 0o755);
      const run = yield* ProcessRunnerModule.make();
      // An empty search path proves the launcher needs neither shell setup nor a global CLI.
      const environment = {
        SystemRoot: hostEnvironment.SystemRoot,
        PATH: "",
        CODEX_HOME: f.environment.CODEX_HOME,
      };
      const binaryPath = yield* resolveManagedCodexBinary({
        binaryPath: "codex",
        homeDirectory: f.homeDirectory,
        platform,
        environment,
        run: run.run,
      });
      assert.equal(binaryPath, installed.binaryPath);
      const homePath = f.environment.CODEX_HOME;
      yield* f.fs.makeDirectory(homePath, { recursive: true });
      const catalogPath = yield* materializeTritonAiCodexModelCatalog({
        binaryPath,
        homePath,
        catalogKey: "codex",
        environment,
        customModelMetadata: {
          "managed-test-model": { name: "Test model", capabilities: { inputModalities: ["text"] } },
        },
      }).pipe(Effect.provideService(ProcessRunnerModule.ProcessRunner, run));
      assert.isDefined(catalogPath);
      const catalog = yield* f.fs.readFileString(catalogPath!);
      assert.include(catalog, '"managed-test-model"');
      assert.isTrue(catalogPath!.startsWith(homePath));
      assert.isFalse(yield* f.fs.exists(f.path.join(f.homeDirectory, ".tritonai-harness")));
    }),
  );
});
