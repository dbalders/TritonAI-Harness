import { describe } from "vite-plus/test";
import { vi } from "vite-plus/test";
import { parse as parseYaml } from "yaml";
import { stringify as stringifyYaml } from "yaml";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import desktopRuntimePackageJson from "../apps/desktop-runtime/package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";
import { assertDesktopUpdatePublishConfiguration } from "./build-desktop-artifact.ts";
import { assertPackagedDesktopUpdateConfig } from "./build-desktop-artifact.ts";
import { assertPackagedFfiRsNativeBinaries } from "./build-desktop-artifact.ts";
import { buildMacDmg } from "./build-desktop-artifact.ts";
import { createDesktopSourceBuildEnvironment } from "./build-desktop-artifact.ts";

import { createStageWorkspaceConfig } from "./build-desktop-artifact.ts";
import { createStagePatchedDependencies } from "./build-desktop-artifact.ts";
import { DesktopUpdatePublishConfigurationMissingError } from "./build-desktop-artifact.ts";
import { findForeignNativePackages } from "./build-desktop-artifact.ts";
import { readStagedPackageManifests } from "./build-desktop-artifact.ts";
import { findMissingRuntimeDeploymentArchitectures } from "./build-desktop-artifact.ts";
import { InvalidAzureTrustedSigningEndpointError } from "./build-desktop-artifact.ts";

import { MacDesktopAppBundleMissingError } from "./build-desktop-artifact.ts";

import { MissingAzureTrustedSigningConfigurationError } from "./build-desktop-artifact.ts";
import { PackagedDesktopUpdateConfigMissingError } from "./build-desktop-artifact.ts";
import { PackagedNativeDependencyMissingError } from "./build-desktop-artifact.ts";
import { renderMacInheritedEntitlements } from "./build-desktop-artifact.ts";
import { resolveAzureTrustedSigningConfiguration } from "./build-desktop-artifact.ts";

import { resolveDesktopRuntimeDependencies } from "./build-desktop-artifact.ts";
import { resolveDesktopRuntimeNativeDependencies } from "./build-desktop-artifact.ts";
import { resolveCuaDriverPatchedLoaderDependencies } from "./build-desktop-artifact.ts";

import { assertNightlySourceVersions } from "./build-desktop-artifact.ts";

import { validateManagedPluginBuildConfiguration } from "./build-desktop-artifact.ts";

// @effect-diagnostics nodeBuiltinImport:off - Tests use Node's glob matcher to verify electron-builder exclusions.
import * as NodeCrypto from "node:crypto";

import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";

import { extractFile } from "@electron/asar";

import { assert, it } from "@effect/vitest";

import * as ConfigProvider from "effect/ConfigProvider";

import * as Deferred from "effect/Deferred";

import * as Fiber from "effect/Fiber";

import * as Exit from "effect/Exit";

import * as FileSystem from "effect/FileSystem";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as PlatformError from "effect/PlatformError";

import * as Option from "effect/Option";

import * as Path from "effect/Path";

import * as Sink from "effect/Sink";

import * as Schema from "effect/Schema";

import * as Stream from "effect/Stream";

import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  buildDesktopBundles,
  DesktopBuildManifestRestoreError,
  BundleNotSelfContainedError,
  BuildCommandFailedError,
  parseWslRuntimeArchiveMembers,
  readWorkspaceConfig,
  createBuildConfig,
  DESKTOP_FILE_EXCLUSIONS,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  UnsupportedDesktopBuildArchitectureError,
  MacPasskeySigningConfigurationResolutionError,
  MissingMacPasskeyProvisioningProfileError,
  packWindowsServerAsar,
  preflightWindowsDesktopBuild,
  renderMacPasskeyEntitlements,
  resolveMacWebAuthnEntitlements,
  resolveMacPasskeySigningConfiguration,
  resolveMergedStageDependencies,
  resolveBuildOptions,
  stageWslRuntimeArchive,
  ancestorNodeModulesPaths,
  copyDirectoryPreservingSymlinks,
  LinuxBrowserSecretHostError,
  stageBrowserSecret,
  validateWindowsPackagedPayload,
  verifyPackagedBundleIsSelfContained,
  WindowsPrimaryNativeProbeError,
  WindowsDesktopBuildPrerequisitesMissingError,
  WindowsPackagedPayloadValidationError,
  stageCursorSdkPlatformPackages,
  WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE,
  WSL_RUNTIME_ARCHIVE_HASH_NAME,
  WSL_RUNTIME_ARCHIVE_NAME,
  wslRuntimeArchiveStem,
} from "./build-desktop-artifact.ts";

import {
  ReleasePackageManifestError,
  releasePackageFiles,
} from "./update-release-package-versions.ts";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

function iconResizeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
) {
  let commandIndex = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockProcess(exitCodes[commandIndex++] ?? 0));
    }),
  );
}

const encodeModuleUrl = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const decodePackageVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

// Keeps pnpm from auto-installing TypeScript, a types-only peer, into the app.

const makeLinuxCliArchiveFixture = Effect.fn("test.makeLinuxCliArchiveFixture")(function* (input: {
  readonly root: string;
  readonly stem: string;
  readonly extraMembers?: ReadonlyArray<string>;
  readonly omitMembers?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const contentRoot = path.join(input.root, "content");
  const members = [
    `${input.stem}/t3`,
    `${input.stem}/client/index.html`,
    `${input.stem}/node_modules/node-pty/package.json`,
    `${input.stem}/node_modules/node-pty/build/Release/pty.node`,
    ...(input.extraMembers ?? []),
  ].filter((member) => !(input.omitMembers ?? []).includes(member));
  for (const member of members) {
    const memberPath = path.join(contentRoot, member);
    yield* fs.makeDirectory(path.dirname(memberPath), { recursive: true });
    yield* fs.writeFileString(memberPath, member);
  }
  const archivePath = path.join(input.root, `${input.stem}.tar.gz`);
  const tar = yield* spawner.spawn(
    ChildProcess.make("tar", ["-czf", archivePath, "-C", contentRoot, "."], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  assert.equal(Number(yield* tar.exitCode), 0);
  return archivePath;
});

function mockProcess(exitCode: number, stdout = "") {
  const encodedStdout = new TextEncoder().encode(stdout);
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: stdout ? Stream.make(encodedStdout) : Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// regression: #145 fix(desktop): harden packaged runtime releases
it("validates every managed plugin configuration and closes loaded providers", async () => {
  const events: string[] = [];
  const composition = {
    version: 1,
    kind: "tritonai-harness-plugin-composition",
    source: {
      repository: "https://github.com/dbalders/TritonAI-Plugins.git",
      ref: "refs/tags/v1.0.0",
      commit: "a".repeat(40),
    },
    packages: [
      {
        id: "alpha",
        name: "@tritonai/plugin-alpha",
        version: "1.0.0",
        digest: "a".repeat(64),
        files: [],
      },
      {
        id: "beta",
        name: "@tritonai/plugin-beta",
        version: "1.0.0",
        digest: "b".repeat(64),
        files: [],
      },
    ],
  } as const;

  let failure: unknown;
  try {
    await validateManagedPluginBuildConfiguration(
      composition,
      { alpha: { enabled: true }, beta: { enabled: false } },
      (plugin) => `/verified-composition/packages/${plugin.id}`,
      async (packageRoot, plugin, configuration) => {
        events.push(`load:${packageRoot}:${String(configuration.enabled)}`);
        if (plugin.id === "beta") throw new Error("invalid beta configuration");
        return { provider: { close: async () => void events.push(`close:${plugin.id}`) } };
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.instanceOf(failure, Error);
  assert.equal(failure.message, "invalid beta configuration");
  assert.deepEqual(events, [
    "load:/verified-composition/packages/alpha:true",
    "load:/verified-composition/packages/beta:false",
    "close:alpha",
  ]);
});

// regression: #151 fix(release): embed frozen plugin build inputs
it("builds the server from the frozen managed plugin snapshot and validated configuration", () => {
  const environment = createDesktopSourceBuildEnvironment(
    {
      TRITONAI_PLUGIN_COMPOSITION_SOURCE: "/moving/source",
      TRITONAI_PLUGIN_SANDBOX_SOURCE: "/moving/runtime",
      TRITONAI_PLUGIN_CONFIGURATION_JSON: '{"stale":true}',
      AZURE_CLIENT_SECRET: "must-not-reach-the-source-build",
      ELECTRON_RUN_AS_NODE: "1",
      Electron_Run_As_Node: "1",
      electron_run_as_node: "1",
      KEEP_ME: "yes",
    },
    {
      sourceRoot: "/frozen/plugin-composition-input",
      sandboxSourceRoot: "/frozen/plugin-sandbox-input/production-integrations/runtime",
      serializedConfiguration: '{"microsoft-365":{"clientId":"public-client"}}',
    },
  );

  assert.equal(environment.TRITONAI_PLUGIN_COMPOSITION_SOURCE, "/frozen/plugin-composition-input");
  assert.equal(
    environment.TRITONAI_PLUGIN_SANDBOX_SOURCE,
    "/frozen/plugin-sandbox-input/production-integrations/runtime",
  );
  assert.equal(
    environment.TRITONAI_PLUGIN_CONFIGURATION_JSON,
    '{"microsoft-365":{"clientId":"public-client"}}',
  );
  assert.notProperty(environment, "AZURE_CLIENT_SECRET");
  assert.notProperty(environment, "ELECTRON_RUN_AS_NODE");
  assert.notProperty(environment, "Electron_Run_As_Node");
  assert.notProperty(environment, "electron_run_as_node");
  assert.equal(environment.KEEP_ME, "yes");
});

// regression: #151 fix(release): embed frozen plugin build inputs
it("removes ambient managed plugin inputs from builds without a frozen composition", () => {
  const environment = createDesktopSourceBuildEnvironment(
    {
      TRITONAI_PLUGIN_COMPOSITION_SOURCE: "/ambient/source",
      TRITONAI_PLUGIN_SANDBOX_SOURCE: "/ambient/runtime",
      TRITONAI_PLUGIN_CONFIGURATION_JSON: '{"ambient":true}',
      KEEP_ME: "yes",
    },
    null,
  );

  assert.notProperty(environment, "TRITONAI_PLUGIN_COMPOSITION_SOURCE");
  assert.notProperty(environment, "TRITONAI_PLUGIN_SANDBOX_SOURCE");
  assert.notProperty(environment, "TRITONAI_PLUGIN_CONFIGURATION_JSON");
  assert.equal(environment.KEEP_ME, "yes");
});

const WINDOWS_PAYLOAD_FIXTURE_VERSION = "1.2.3";

const makeWindowsPayloadFixture = Effect.fn("test.makeWindowsPayloadFixture")(function* (input: {
  readonly copyUnpackedNatives: boolean;
  readonly serverEntrySource?: string;
  readonly pluginRuntimeVersion?: string;
  readonly wslRuntime?: "valid" | "loose-server-tree" | "missing-pty" | "bad-digest";
  readonly targetArch?: "x64" | "arm64";
  readonly ptyPrebuildArch?: "x64" | "arm64";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-windows-payload-test-",
  });
  const sourceDir = path.join(tempDir, "server-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");
  yield* fs.writeFileString(nativePath, "MZ native-binary");
  if (input.pluginRuntimeVersion !== undefined) {
    const effectRoot = path.join(sourceDir, "node_modules/effect");
    yield* fs.makeDirectory(path.join(effectRoot, "dist"), { recursive: true });
    yield* fs.writeFileString(
      path.join(effectRoot, "package.json"),
      `{"name":"effect","version":"${input.pluginRuntimeVersion}"}`,
    );
    yield* fs.writeFileString(
      path.join(effectRoot, "dist/index.js"),
      "export const Effect = {};\n",
    );
  }

  const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  yield* packWindowsServerAsar({ sourceDir, asarPath: generatedAsarPath, arch: "x64" });

  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
  if (input.copyUnpackedNatives) {
    yield* fs.copy(
      `${generatedAsarPath}.unpacked`,
      path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
    );
  }
  yield* fs.writeFileString(
    path.join(resourcesDir, "resource-monitor/t3-resource-monitor.exe"),
    "monitor",
  );
  const appExecutableName = "t3code.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");

  if (input.wslRuntime !== undefined) {
    const stem = wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, input.targetArch ?? "x64");
    const sourceArchivePath =
      input.wslRuntime === "loose-server-tree"
        ? yield* makeLinuxCliArchiveFixture({
            root: path.join(tempDir, "wsl-runtime"),
            stem: "apps",
            omitMembers: ["apps/t3", "apps/client/index.html"],
            extraMembers: ["apps/server/dist/bin.mjs", "node_modules/node-pty/package.json"],
          })
        : yield* makeLinuxCliArchiveFixture({
            root: path.join(tempDir, "wsl-runtime"),
            stem,
            ...(input.wslRuntime === "missing-pty" || input.ptyPrebuildArch !== undefined
              ? { omitMembers: [`${stem}/node_modules/node-pty/build/Release/pty.node`] }
              : {}),
            ...(input.ptyPrebuildArch !== undefined
              ? {
                  extraMembers: [
                    `${stem}/node_modules/node-pty/prebuilds/linux-${input.ptyPrebuildArch}/pty.node`,
                  ],
                }
              : {}),
          });
    const archivePath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_NAME);
    const hashPath = path.join(resourcesDir, WSL_RUNTIME_ARCHIVE_HASH_NAME);
    yield* stageWslRuntimeArchive({ sourceArchivePath, archivePath, hashPath });
    if (input.wslRuntime === "bad-digest") {
      yield* fs.writeFileString(hashPath, `${"0".repeat(64)}\n`);
    }
  }

  return {
    stageDistDir,
    packagedAppDir,
    sourceDir,
    generatedAsarPath,
    appExecutableName,
  } as const;
});

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it.effect("rejects overlapping builds from another process until restoration finishes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-concurrent-build-" });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        '{ "scripts": { "build:desktop": "node build.cjs" } }',
      );
      const original = '{ "version": "0.0.42", "private": true }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      yield* fs.writeFileString(
        path.join(root, "build.cjs"),
        `require("node:fs").writeFileSync("version.txt", require("./apps/server/package.json").version);`,
      );
      const restoring = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const contenderPath = path.join(root, "contender.mjs");
      yield* fs.writeFileString(
        contenderPath,
        `import * as Effect from ${yield* encodeModuleUrl(import.meta.resolve("effect/Effect"))};
           import * as NodeServices from ${yield* encodeModuleUrl(import.meta.resolve("@effect/platform-node/NodeServices"))};
           import { buildDesktopBundles } from ${yield* encodeModuleUrl(import.meta.resolve("./build-desktop-artifact.ts"))};
           const result = await Effect.runPromise(buildDesktopBundles(process.argv[2], "0.0.44", false).pipe(
             Effect.as("success"), Effect.catch(error => Effect.succeed(error._tag)),
             Effect.scoped, Effect.provide(NodeServices.layer)));
           process.stdout.write(result);`,
      );
      const first = yield* Effect.forkChild(
        Effect.exit(buildDesktopBundles(root, "0.0.43", false)).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            writeFileString: (filePath, contents, options) =>
              filePath === path.join(root, releasePackageFiles[0]) && contents === original
                ? Deferred.succeed(restoring, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(fs.writeFileString(filePath, contents, options)),
                  )
                : fs.writeFileString(filePath, contents, options),
          }),
        ),
      );
      yield* Deferred.await(restoring);
      yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [contenderPath, root]),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText, Stream.mkString),
            child.stderr.pipe(Stream.decodeText, Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(Number(exitCode), 0, stderr);
        assert.equal(stdout, "DesktopBuildAlreadyRunningError");
      }).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
      const firstExit = yield* Fiber.join(first);
      assert.isTrue(Exit.isSuccess(firstExit));
      assert.equal(yield* fs.readFileString(path.join(root, "version.txt")), "0.0.43");
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
      yield* buildDesktopBundles(root, "0.0.44", false);
      assert.equal(yield* fs.readFileString(path.join(root, "version.txt")), "0.0.44");
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
    }),
  );

  it.effect("restores manifests and releases the checkout lock after interruption", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-interrupted-build-" });
      const original = '{ "version": "0.0.42", "private": true }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      const started = yield* Deferred.make<void>();
      const childStopped = yield* Deferred.make<{ lockExists: boolean; version: string }>();
      const build = yield* Effect.forkChild(
        buildDesktopBundles(root, "0.0.43", false).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.acquireRelease(
                Effect.succeed({ ...mockProcess(0), exitCode: Effect.never }).pipe(
                  Effect.tap(() => Deferred.succeed(started, undefined)),
                ),
                () =>
                  Effect.gen(function* () {
                    const lockExists = yield* fs.exists(path.join(root, ".desktop-build.lock"));
                    const manifest = yield* decodePackageVersion(
                      yield* fs.readFileString(path.join(root, releasePackageFiles[0])),
                    );
                    yield* Deferred.succeed(childStopped, {
                      lockExists,
                      version: manifest.version,
                    });
                  }).pipe(Effect.orDie),
              ),
            ),
          ),
          Effect.scoped,
        ),
      );
      yield* Deferred.await(started);
      const aligned = yield* decodePackageVersion(
        yield* fs.readFileString(path.join(root, releasePackageFiles[0])),
      );
      assert.equal(aligned.version, "0.0.43");
      yield* Fiber.interrupt(build);
      assert.deepEqual(yield* Deferred.await(childStopped), {
        lockExists: true,
        version: "0.0.43",
      });
      assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
      for (const relativePath of releasePackageFiles) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
      yield* buildDesktopBundles(root, "0.0.44", false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
        ),
      );
      assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
    }),
  );

  it.effect(
    "builds web, server and desktop with the resolved version, restores changed manifests and preserves edits to matching ones",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-build-version-" });
        const packageJson = `{
          "name": "desktop-version-fixture",
          "version": "0.0.42",
          "scripts": { "build:desktop": "node build.cjs" }
        }`;
        yield* fs.writeFileString(path.join(root, "package.json"), packageJson);
        const version = "0.0.43-nightly.20260920.2018";
        const matchingPath = "packages/contracts/package.json";
        const originals = releasePackageFiles.map((relativePath, index) => ({
          relativePath,
          contents: `{ "version": "${relativePath === matchingPath ? version : `0.0.${index + 1}`}", "name": "${relativePath}" }\r\n`,
        }));
        const afterBuild = originals.map(({ relativePath, contents }) => ({
          relativePath,
          contents:
            relativePath === matchingPath
              ? `${JSON.stringify({ version, name: matchingPath, description: "edited during compilation" })}\n`
              : contents,
        }));
        for (const { relativePath, contents } of originals) {
          const filePath = path.join(root, relativePath);
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
          yield* fs.writeFileString(filePath, contents);
        }
        yield* fs.writeFileString(
          path.join(root, "build.cjs"),
          `require("node:fs").writeFileSync("version.txt", [
            process.env.APP_VERSION,
            require("./apps/web/package.json").version,
            require("./apps/server/package.json").version,
            require("./apps/desktop/package.json").version
          ].join("\\n"));
          const manifest = require("./${matchingPath}");
          manifest.description = "edited during compilation";
          require("node:fs").writeFileSync("${matchingPath}", JSON.stringify(manifest) + "\\n");`,
        );
        yield* buildDesktopBundles(root, version, false);
        assert.equal(
          yield* fs.readFileString(path.join(root, "version.txt")),
          [version, version, version, version].join("\n"),
        );
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(yield* fs.readFileString(path.join(root, relativePath)), contents);
        }
        assert.equal(yield* fs.readFileString(path.join(root, "package.json")), packageJson);
        yield* fs.writeFileString(path.join(root, "build.cjs"), "process.exit(1);");
        const failure = yield* Effect.flip(buildDesktopBundles(root, "0.0.44", false));
        assert.instanceOf(failure, BuildCommandFailedError);
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(yield* fs.readFileString(path.join(root, relativePath)), contents);
        }
        const invalidPath = releasePackageFiles[releasePackageFiles.length - 1]!;
        yield* fs.writeFileString(path.join(root, invalidPath), "invalid manifest");
        // A successful child would leave a marker if partial alignment accidentally starts it.
        yield* fs.writeFileString(
          path.join(root, "build.cjs"),
          'require("node:fs").writeFileSync("unexpected-build.txt", "started");',
        );
        const alignmentFailure = yield* Effect.flip(buildDesktopBundles(root, "0.0.44", false));
        assert.instanceOf(alignmentFailure, ReleasePackageManifestError);
        for (const { relativePath, contents } of afterBuild) {
          assert.equal(
            yield* fs.readFileString(path.join(root, relativePath)),
            relativePath === invalidPath ? "invalid manifest" : contents,
          );
        }
        assert.isFalse(yield* fs.exists(path.join(root, "unexpected-build.txt")));
        assert.isFalse(yield* fs.exists(path.join(root, ".desktop-build.lock")));
        assert.equal(yield* fs.readFileString(path.join(root, "package.json")), packageJson);
      }),
  );

  it.effect("reports a restore failure while still restoring the remaining manifests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-manifest-restore-failure-" });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        `{
          "name": "restore-fixture", "scripts": { "build:desktop": "node build.cjs" }
        }`,
      );
      yield* fs.writeFileString(path.join(root, "build.cjs"), "process.exit(0);");
      const original = '{ "version": "0.0.42" }\n';
      for (const relativePath of releasePackageFiles) {
        const filePath = path.join(root, relativePath);
        yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
        yield* fs.writeFileString(filePath, original);
      }
      const failedPath = path.join(root, releasePackageFiles[0]);
      const writeFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "writeFileString",
        pathOrDescriptor: failedPath,
      });
      const failure = yield* Effect.flip(buildDesktopBundles(root, "0.0.43", false)).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (filePath, contents, options) =>
            filePath === failedPath && contents === original
              ? Effect.fail(writeFailure)
              : fs.writeFileString(filePath, contents, options),
        }),
      );
      assert.instanceOf(failure, DesktopBuildManifestRestoreError);
      assert.notEqual(yield* fs.readFileString(failedPath), original);
      for (const relativePath of releasePackageFiles.slice(1)) {
        assert.equal(yield* fs.readFileString(path.join(root, relativePath)), original);
      }
    }),
  );

  it.effect(
    "rejects a nightly label over stable sources and mismatched nightly source packages",
    () =>
      Effect.gen(function* () {
        const nightly = "0.3.4-nightly.20260912.1";
        yield* assertNightlySourceVersions(nightly, {
          desktop: nightly,
          server: nightly,
          web: nightly,
        });
        yield* assertNightlySourceVersions("0.3.4", {
          desktop: "0.3.3",
          server: "0.3.4",
          web: "0.3.3",
        });
        for (const [artifact, packages] of [
          [nightly, { desktop: "0.3.3", server: "0.3.3", web: "0.3.3" }],
          [nightly, { desktop: nightly, server: nightly, web: "0.3.3" }],
          ["0.3.4", { desktop: nightly, server: nightly, web: nightly }],
        ] as const) {
          const error = yield* Effect.flip(assertNightlySourceVersions(artifact, packages));
          assert.equal(error._tag, "NightlySourceVersionMismatchError");
        }
      }),
  );

  // regression: #155 fix(release): require packaged updater config
  it.effect(
    "fails before macOS and Windows packaging when updater publishing is unconfigured",
    () =>
      Effect.gen(function* () {
        for (const platform of ["mac", "win"] as const) {
          const error = yield* assertDesktopUpdatePublishConfiguration({
            platform,
            updateChannel: "latest",
            mockUpdates: false,
          }).pipe(Effect.flip);

          assert.instanceOf(error, DesktopUpdatePublishConfigurationMissingError);
          assert.equal(error.platform, platform);
          assert.equal(error.updateChannel, "latest");
          assert.include(error.message, "T3CODE_DESKTOP_UPDATE_REPOSITORY=owner/repo");
          assert.include(error.message, "--mock-updates");
        }
      }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("omits update feeds for pull request preview builds", () =>
    Effect.gen(function* () {
      const preview = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33-pr.8182.1",
        false,
        false,
        undefined,
        undefined,
      );
      const release = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33",
        false,
        false,
        undefined,
        undefined,
      );

      const previewChannel = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.41-preview.20260912.1589",
        false,
        false,
        undefined,
        undefined,
      );

      assert.isNull(preview.publish);
      assert.isNull(previewChannel.publish);
      assert.deepStrictEqual(release.publish, [
        {
          provider: "github",
          owner: "pingdotgg",
          repo: "t3code",
          releaseType: "release",
        },
      ]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "pingdotgg/t3code" } }),
        ),
      ),
    ),
  );

  // regression: #391 fix(build): align executable and desktop runtime packaging
  it.effect("keeps the checked-in desktop runtime manifest aligned with the packaged runtime", () =>
    Effect.gen(function* () {
      const { catalog = {} } = yield* readWorkspaceConfig();
      assert.deepStrictEqual(
        resolveCatalogDependencies(
          desktopRuntimePackageJson.dependencies,
          catalog,
          "apps/desktop-runtime",
        ),
        {
          ...resolveCatalogDependencies(serverPackageJson.dependencies, catalog, "apps/server"),
          ...resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, catalog),
        },
      );
      assert.deepStrictEqual(
        desktopRuntimePackageJson.optionalDependencies,
        resolveDesktopRuntimeNativeDependencies(),
      );
    }),
  );

  it("finds staged packages whose os or cpu excludes the target", () => {
    const manifests = [
      { name: "plain", version: "1.0.0" },
      {
        name: "@trycua/cua-driver-darwin-arm64",
        version: "0.19.3",
        os: ["darwin"],
        cpu: ["arm64"],
      },
      { name: "@trycua/cua-driver-darwin-x64", version: "0.19.3", os: ["darwin"], cpu: ["x64"] },
      { name: "@napi-rs/keyring-win32-x64-msvc", version: "1.3.0", os: ["win32"], cpu: ["x64"] },
      { name: "@cursor/sdk-linux-arm64", version: "1.0.35", os: ["linux"], cpu: ["arm64"] },
      { name: "not-windows", version: "1.0.0", os: ["!win32"] },
      { name: "not-darwin", version: "1.0.0", os: ["!darwin"] },
      { name: "fsevents", version: "2.3.3", os: ["darwin"] },
    ];
    assert.deepStrictEqual(
      findForeignNativePackages(manifests, { os: ["darwin"], cpu: ["arm64"] }),
      [
        "@cursor/sdk-linux-arm64@1.0.35",
        "@napi-rs/keyring-win32-x64-msvc@1.3.0",
        "@trycua/cua-driver-darwin-x64@0.19.3",
        "not-darwin@1.0.0",
      ],
    );
    assert.deepStrictEqual(
      findForeignNativePackages(manifests, { os: ["darwin"], cpu: ["arm64", "x64"] }),
      [
        "@cursor/sdk-linux-arm64@1.0.35",
        "@napi-rs/keyring-win32-x64-msvc@1.3.0",
        "not-darwin@1.0.0",
      ],
    );
  });

  it.effect("reads real packages from a pnpm store and skips links and store files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stageAppDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-stage-manifests-" });
      const store = path.join(stageAppDir, "node_modules", ".pnpm");
      const writePackage = (entry: string, name: string, manifest: object) =>
        Effect.gen(function* () {
          const packageDir = path.join(store, entry, "node_modules", name);
          yield* fs.makeDirectory(packageDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(packageDir, "package.json"),
            JSON.stringify({ name, ...manifest }),
          );
          return packageDir;
        });
      yield* fs.makeDirectory(store, { recursive: true });
      yield* fs.writeFileString(path.join(store, "lock.yaml"), "lockfileVersion: '9.0'\n");
      const keyring = yield* writePackage("@napi-rs+keyring@1.3.0", "@napi-rs/keyring", {
        version: "1.3.0",
      });
      const windows = yield* writePackage(
        "@napi-rs+keyring-win32-x64-msvc@1.3.0",
        "@napi-rs/keyring-win32-x64-msvc",
        { version: "1.3.0", os: ["win32"], cpu: ["x64"] },
      );
      // pnpm links each dependency beside the package that requires it.
      yield* fs.symlink(windows, path.join(path.dirname(keyring), "keyring-win32-x64-msvc"));
      yield* writePackage("odd@1.0.0", "odd", { version: 1, os: "darwin", cpu: [7, "arm64"] });

      const manifests = yield* readStagedPackageManifests(stageAppDir);
      assert.deepStrictEqual(
        manifests.toSorted((left, right) => left.name.localeCompare(right.name)),
        [
          { name: "@napi-rs/keyring", version: "1.3.0", os: undefined, cpu: undefined },
          {
            name: "@napi-rs/keyring-win32-x64-msvc",
            version: "1.3.0",
            os: ["win32"],
            cpu: ["x64"],
          },
          { name: "odd", version: undefined, os: ["darwin"], cpu: ["arm64"] },
        ],
      );
      assert.deepStrictEqual(
        findForeignNativePackages(manifests, { os: ["darwin"], cpu: ["arm64"] }),
        ["@napi-rs/keyring-win32-x64-msvc@1.3.0"],
      );
    }),
  );

  // pnpm writes "set this to true or false" placeholders into allowBuilds when a
  // tarball changes. pnpm ignores them, but the release build decode rejects them.
  it.effect("decodes the repo allowBuilds and every file: tarball it names exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { allowBuilds = {} } = yield* readWorkspaceConfig();
      const repoRoot = path.join(import.meta.dirname, "..");
      for (const key of Object.keys(allowBuilds)) {
        const tarball = key.split("@file:")[1]?.replace(/\(patch_hash=[a-f0-9]+\)$/, "");
        if (tarball === undefined) continue;
        assert.isTrue(
          yield* fs.exists(path.join(repoRoot, tarball)),
          `allowBuilds names a missing tarball: ${key}`,
        );
      }
    }),
  );

  it("stages only the externals of both bundles in merged packages", () => {
    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "mac",
        serverDependencies: {
          "@cursor/sdk": "1.0.22",
          "@anthropic-ai/claude-agent-sdk": "^0.3.170",
          "@ff-labs/fff-node": "0.9.4",
          "@opencode-ai/sdk": "^1.3.15",
          "@pierre/diffs": "1.3.0",
          "node-pty": "1.1.0",
        },
        desktopDependencies: {
          "@napi-rs/keyring": "1.3.0",
          "playwright-core": "1.60.0",
        },
        arch: "arm64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@cursor/sdk": "1.0.22",
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@napi-rs/keyring": "1.3.0",
        "playwright-core": "1.60.0",
        "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      },
    );

    assert.deepStrictEqual(
      resolveMergedStageDependencies({
        platform: "linux",
        serverDependencies: { "@ff-labs/fff-node": "0.9.4", "node-pty": "1.1.0", effect: "4.0.0" },
        desktopDependencies: { "@crowecawcaw/xa11y": "0.13.0" },
        arch: "x64",
        fffNodeVersion: "0.9.4",
      }),
      {
        "@ff-labs/fff-node": "0.9.4",
        "node-pty": "1.1.0",
        "@crowecawcaw/xa11y": "0.13.0",
        "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
        "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
        effect: "4.0.0",
      },
    );
  });

  it.effect("ships Cursor platform assets outside asar for spawning and native loading", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cursor-helpers-" });
        const nodeModules = path.join(root, "node_modules");
        const destination = path.join(root, "resources/node_modules/@cursor");
        const cursorDirectory = symlinksSupported
          ? path.join(root, "store/@cursor")
          : path.join(nodeModules, "@cursor");
        yield* fs.makeDirectory(path.join(cursorDirectory, "sdk"), { recursive: true });
        if (symlinksSupported) {
          yield* fs.makeDirectory(path.join(nodeModules, "@cursor"), { recursive: true });
          yield* fs.symlink(
            path.join(cursorDirectory, "sdk"),
            path.join(nodeModules, "@cursor/sdk"),
          );
        }
        const helpers = [
          "sdk-darwin-arm64/bin/rg",
          "sdk-darwin-arm64/bin/cursorsandbox",
          "sdk-darwin-arm64/vendor/tree-sitter/index.js",
          "sdk-darwin-arm64/vendor/tree-sitter/binding.node",
          "sdk-darwin-arm64/vendor/tree-sitter-bash/binding.node",
          "sdk-darwin-arm64/package.json",
          "sdk-win32-x64/bin/rg.exe",
        ];
        for (const helper of helpers) {
          const source = path.join(cursorDirectory, helper);
          yield* fs.makeDirectory(path.dirname(source), { recursive: true });
          yield* fs.writeFileString(source, "fixture helper", { mode: 0o755 });
        }
        yield* stageCursorSdkPlatformPackages(nodeModules, destination);
        for (const helper of helpers) {
          assert.equal(yield* fs.readFileString(path.join(destination, helper)), "fixture helper");
          const packagedPath = `node_modules/@cursor/${helper}`;
          assert.isTrue(
            DESKTOP_FILE_EXCLUSIONS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob.slice(1)),
            ),
          );
          assert.isTrue(
            WINDOWS_SERVER_ASAR_IGNORE_GLOBS.some((glob) =>
              NodePath.matchesGlob(packagedPath, glob),
            ),
          );
        }
      }),
    ),
  );

  it.effect("unpacks target Windows natives while excluding the other architecture", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-windows-architecture-test-",
        });
        const sourceDir = path.join(tempDir, "server");
        const nativeFiles = [
          "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-arm64/conpty/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-x64/OpenConsole.exe",
          "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64/OpenConsole.exe",
          "node_modules/node-pty/prebuilds/win32-x64/pty.node",
          "node_modules/node-pty/prebuilds/linux-x64/pty.node",
        ];

        for (const nativeFile of nativeFiles) {
          const nativePath = path.join(sourceDir, nativeFile);
          yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
          yield* fs.writeFileString(nativePath, nativeFile.includes("linux") ? "\x7fELF" : "MZ");
        }

        const asarPath = path.join(tempDir, "server.asar");
        yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });
        const unpackedRoot = `${asarPath}.unpacked`;

        assert.isTrue(
          yield* fs.exists(
            path.join(
              unpackedRoot,
              "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
            ),
          ),
        );
        assert.isTrue(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
          ),
        );
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/linux-x64")),
        );
        assert.equal(
          extractFile(
            asarPath,
            path.join("node_modules", "node-pty", "prebuilds", "linux-x64", "pty.node"),
          ).toString(),
          "\x7fELF",
        );
        assert.isFalse(
          yield* fs.exists(path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-arm64")),
        );
        assert.isFalse(
          yield* fs.exists(
            path.join(unpackedRoot, "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64"),
          ),
        );
      }),
    ),
  );

  it.effect("reports missing Windows toolchain capabilities before building", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-windows-preflight-" });
        const pythonPath = path.join(tempDir, "python.exe");
        yield* fs.writeFileString(pythonPath, "python");
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as { readonly command: string };
            const fails =
              childProcess.command === "rustc" ||
              childProcess.command === "powershell.exe" ||
              childProcess.command === pythonPath;
            return Effect.succeed(mockProcess(fails ? 1 : 0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
          bundlesWslRuntime: true,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { npm_config_python: pythonPath } }),
              ),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, WindowsDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["rust", "python", "msvc"]);
        assert.equal(error.rustTarget, "x86_64-pc-windows-msvc");
        assert.include(error.message, "Visual Studio Build Tools components");
      }),
    ),
  );

  it.effect("does not require MSVC when reusing a prebuilt Windows resource monitor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-windows-preflight-" });
        const pythonPath = path.join(tempDir, "python.exe");
        yield* fs.writeFileString(pythonPath, "python");
        const commands: string[] = [];
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as { readonly command: string };
            commands.push(childProcess.command);
            return Effect.succeed(mockProcess(childProcess.command === "powershell.exe" ? 1 : 0));
          }),
        );

        yield* preflightWindowsDesktopBuild({
          arch: "x64",
          bundlesWslRuntime: true,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: {
                    npm_config_python: pythonPath,
                    T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true",
                  },
                }),
              ),
            ),
          ),
        );

        assert.notInclude(commands, "powershell.exe");
      }),
    ),
  );

  it.effect("rejects a PATH-discovered Python executable that is not Python 3", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-python2-preflight-" });
        const pythonPath = path.join(tempDir, "python");
        yield* fs.writeFileString(pythonPath, "python2");
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const childProcess = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
            };
            if (childProcess.command === "python") {
              return Effect.succeed(mockProcess(0, `${pythonPath}\n`));
            }
            if (childProcess.command === pythonPath) {
              return Effect.succeed(mockProcess(1));
            }
            return Effect.succeed(mockProcess(0));
          }),
        );
        const error = yield* preflightWindowsDesktopBuild({
          arch: "x64",
          bundlesWslRuntime: false,
        }).pipe(
          Effect.provide(
            Layer.merge(
              spawner,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
                }),
              ),
            ),
          ),
          Effect.flip,
        );

        assert.instanceOf(error, WindowsDesktopBuildPrerequisitesMissingError);
        assert.deepStrictEqual(error.missing, ["python"]);
      }),
    ),
  );

  // The fixture's t3code.exe is a text placeholder, not an executable. These
  // cases reach the native-load probe, so pin only that host-platform check to
  // Linux. Host-native paths and the real Windows tar/archive checks still run.
  it.effect("validates every ASAR-unpacked native in the packaged Windows payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        const secondAsarPath = path.join(path.dirname(fixture.generatedAsarPath), "second.asar");
        yield* packWindowsServerAsar({
          sourceDir: fixture.sourceDir,
          asarPath: secondAsarPath,
          arch: "x64",
        });
        const [firstAsar, secondAsar] = yield* Effect.all([
          fs.readFile(fixture.generatedAsarPath),
          fs.readFile(secondAsarPath),
        ]);

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        assert.deepStrictEqual(result.unpackedFiles, ["node_modules/native/addon.node"]);
        assert.isBelow(result.fileCount, WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT);
        assert.deepStrictEqual(secondAsar, firstAsar);
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each(["x64", "arm64"] as const)(
    "accepts an embedded archive with the Linux %s node-pty prebuild",
    (targetArch) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeWindowsPayloadFixture({
            copyUnpackedNatives: true,
            wslRuntime: "valid",
            targetArch,
            ptyPrebuildArch: targetArch,
          });
          const result = yield* validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch,
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            expectWslRuntime: true,
          });

          assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        }),
      ).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect.each(["x64", "arm64"] as const)(
    "rejects a node-pty prebuild for the wrong architecture in a Linux %s archive",
    (targetArch) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeWindowsPayloadFixture({
            copyUnpackedNatives: true,
            wslRuntime: "valid",
            targetArch,
            ptyPrebuildArch: targetArch === "x64" ? "arm64" : "x64",
          });
          const error = yield* validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch,
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            expectWslRuntime: true,
          }).pipe(Effect.flip);

          assert.instanceOf(error, WindowsPackagedPayloadValidationError);
          assert.equal(error.reason, "wsl-runtime-invalid");
        }),
      ),
  );

  it.effect("rejects an embedded archive built for a different release version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "valid",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: "9.9.9",
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  // regression: #224 fix(windows): restore managed plugins in packaged builds
  it.effect("requires the matching plugin host runtime in the final Windows archive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const pluginRuntimeVersion of [undefined, "4.0.0-beta.78", "4.0.0-rc.112"]) {
          const fixture = yield* makeWindowsPayloadFixture({
            copyUnpackedNatives: true,
            ...(pluginRuntimeVersion ? { pluginRuntimeVersion } : {}),
          });
          const check = validateWindowsPackagedPayload({
            stageDistDir: fixture.stageDistDir,
            appExecutableName: fixture.appExecutableName,
            targetArch: "x64",
            appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
            managedPluginRuntimeVersion: "4.0.0-rc.112",
          });
          if (pluginRuntimeVersion === "4.0.0-rc.112") {
            const result = yield* check;
            assert.isBelow(result.fileCount, WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT);
          } else {
            const error = yield* check.pipe(Effect.flip);
            assert.instanceOf(error, WindowsPackagedPayloadValidationError);
            assert.equal(error.reason, "sidecar-invalid");
          }
        }
      }),
    ),
  );

  it.effect("rejects a Windows package missing its expected WSL runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-missing");
      }),
    ),
  );

  it.effect("rejects an embedded archive without the Linux node-pty binary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "missing-pty",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
        assert.deepStrictEqual(error.missingFiles, [
          `${wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, "x64")}/node_modules/node-pty/build/Release/pty.node`,
          `${wslRuntimeArchiveStem(WINDOWS_PAYLOAD_FIXTURE_VERSION, "x64")}/node_modules/node-pty/prebuilds/linux-x64/pty.node`,
        ]);
      }),
    ),
  );

  it.effect("rejects an emitted WSL archive whose sidecar digest does not match", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          wslRuntime: "bad-digest",
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          expectWslRuntime: true,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "wsl-runtime-invalid");
      }),
    ),
  );

  it.effect("probes fff through the packaged Windows primary instead of helper executables", () => {
    const commands: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: {
        readonly cwd?: string;
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
        vi.stubEnv("Electron_Run_As_Node", "1");
        vi.stubEnv("Electron_No_Asar", "1");
        vi.stubEnv("Node_Options", "--require=ambient-hook.cjs");
        vi.stubEnv("Node_Path", "/ambient/node_modules");
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });

        assert.deepStrictEqual(result.runtimeChecks, {
          windowsPrimaryNativeLoad: "passed",
          sidecarSelfContainment: "passed",
        });
        const primaryProbe = commands.find(
          (command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1",
        );
        if (primaryProbe === undefined) return assert.fail("Windows primary probe was not spawned");

        assert.equal(
          primaryProbe.command,
          path.join(fixture.packagedAppDir, fixture.appExecutableName),
        );
        assert.deepStrictEqual(primaryProbe.args.slice(0, 3), [
          "--no-global-search-paths",
          "--input-type=module",
          "--eval",
        ]);
        assert.include(primaryProbe.args[3], "FileFinder.create");
        assert.equal(
          primaryProbe.args[4],
          path.join(
            fixture.packagedAppDir,
            "resources/server.asar/node_modules/@ff-labs/fff-node/dist/index.js",
          ),
        );
        assert.equal(primaryProbe.options.cwd, fixture.packagedAppDir);
        assert.equal(primaryProbe.options.env?.NODE_PATH, "");
        assert.deepStrictEqual(
          Object.keys(primaryProbe.options.env ?? {})
            .filter((key) =>
              ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", "NODE_OPTIONS", "NODE_PATH"].includes(
                key.toUpperCase(),
              ),
            )
            .sort(),
          ["ELECTRON_RUN_AS_NODE", "NODE_PATH"],
        );
        const sidecarProbe = commands.find((command) => command.args.includes("--version"));
        if (sidecarProbe === undefined) return assert.fail("Server sidecar probe was not spawned");
        assert.deepStrictEqual(
          Object.keys(sidecarProbe.options.env ?? {}).filter((key) =>
            ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase()),
          ),
          ["NODE_PATH"],
        );
        assert.equal(sidecarProbe.options.env?.NODE_PATH, "");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    );
  });

  it.effect("refuses a Linux build on a host that cannot build the browser secret helper", () => {
    const commands: Array<{ readonly command: string }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.gen(function* () {
      const error = yield* stageBrowserSecret({
        repoRoot: "/repo",
        stageResourcesDir: "/stage/resources",
        platform: "linux",
        arch: "x64",
        verbose: false,
      }).pipe(Effect.flip);
      assert.instanceOf(error, LinuxBrowserSecretHostError);
      assert.equal(error.hostPlatform, "darwin");
      assert.include(error.message, "Linux host");
      assert.lengthOf(commands, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcess.Platform, "darwin"),
          Layer.succeed(HostProcess.Architecture, "arm64"),
        ),
      ),
    );
  });

  describe.each(Array.from(["win", "mac"] as const, (scenario) => ({ scenario })))(
    "case $scenario",
    ({ scenario: platform }) => {
      it.effect(
        `preserves update-compatible app IDs and separate Nightly names on ${platform}`,
        () =>
          Effect.gen(function* () {
            const stable = yield* createBuildConfig(
              platform,
              platform === "win" ? "nsis" : "dmg",
              "0.3.3",
              false,
              false,
              undefined,
              undefined,
            );
            const nightly = yield* createBuildConfig(
              platform,
              platform === "win" ? "nsis" : "dmg",
              "0.3.4-nightly.20260912.12",
              false,
              false,
              undefined,
              undefined,
            );
            assert.equal(stable.appId, "edu.ucsd.tritonai.harness");
            assert.equal(
              nightly.appId,
              platform === "mac"
                ? "edu.ucsd.tritonai.harness"
                : "edu.ucsd.tritonai.harness.nightly",
            );
            assert.deepEqual(stable.extraMetadata, { name: "tritonai-harness" });
            assert.deepEqual(nightly.extraMetadata, { name: "tritonai-harness-nightly" });
            assert.equal(stable.productName, "TritonAI Harness");
            assert.equal(nightly.productName, "TritonAI Harness (Nightly)");
            if (platform === "mac") {
              assert.deepEqual((nightly.mac as Record<string, unknown>).protocols, [
                { name: "TritonAI Harness", schemes: ["tritonai-harness-nightly"] },
                { name: "Web site URL", schemes: ["http", "https"], role: "Viewer" },
              ]);
            }
          }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
      );
    },
  );

  // regression: #8206 fix(desktop): sign Windows native addons
  it.effect("configures Windows executable metadata and native signing extensions", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );

      const win = config.win as Record<string, unknown>;
      const nsis = config.nsis as Record<string, unknown>;
      assert.equal(win.icon, "icon.ico");
      assert.deepStrictEqual(win.signExts, [".node", ".dll"]);
      assert.equal(win.signAndEditExecutable, true);
      assert.notProperty(win, "azureSignOptions");
      assert.equal(nsis.include, "apps/desktop/resources/installer.nsh");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("fails closed when a signed Windows build is missing Azure configuration", () =>
    Effect.gen(function* () {
      const error = yield* resolveAzureTrustedSigningConfiguration().pipe(Effect.flip);

      assert.instanceOf(error, MissingAzureTrustedSigningConfigurationError);
      assert.deepStrictEqual(error.missingVariables, [
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_TRUSTED_SIGNING_ENDPOINT",
        "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
        "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
        "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("forces Azure signing for signed Windows builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "0.3.0",
        true,
        false,
        undefined,
        undefined,
      );

      const win = config.win as Record<string, unknown>;
      assert.equal(config.forceCodeSigning, true);
      assert.deepStrictEqual(win.azureSignOptions, {
        publisherName: "University of California San Diego",
        endpoint: "https://eus.codesigning.azure.net",
        certificateProfileName: "tritonai-release",
        codeSigningAccountName: "ucsd-tritonai",
        fileDigest: "SHA256",
        timestampDigest: "SHA256",
        timestampRfc3161: "http://timestamp.acs.microsoft.com",
      });
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              AZURE_TENANT_ID: "tenant",
              AZURE_CLIENT_ID: "client",
              AZURE_CLIENT_SECRET: "secret",
              AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net",
              AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "ucsd-tritonai",
              AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "tritonai-release",
              AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "University of California San Diego",
            },
          }),
        ),
      ),
    ),
  );

  it.effect("rejects non-HTTPS Azure Trusted Signing endpoints", () =>
    Effect.gen(function* () {
      const error = yield* resolveAzureTrustedSigningConfiguration().pipe(Effect.flip);
      assert.instanceOf(error, InvalidAzureTrustedSigningEndpointError);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              AZURE_TENANT_ID: "tenant",
              AZURE_CLIENT_ID: "client",
              AZURE_CLIENT_SECRET: "secret",
              AZURE_TRUSTED_SIGNING_ENDPOINT: "http://insecure.example",
              AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "ucsd-tritonai",
              AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "tritonai-release",
              AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "University of California San Diego",
            },
          }),
        ),
      ),
    ),
  );

  it.effect("rejects a cross-architecture Windows payload without its primary executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const executablePath = path.join(fixture.packagedAppDir, fixture.appExecutableName);
        yield* fs.remove(executablePath);

        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPrimaryNativeProbeError);
        assert.equal(error.executablePath, executablePath);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "win32"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    ),
  );

  it.effect("rejects a packaged sidecar whose ASAR-unpacked native is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: false });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unpacked-native-missing");
        assert.deepStrictEqual(error.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);
      }),
    ),
  );

  it.effect("rejects directories in place of packaged executable files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const nativePath = path.join(
          fixture.packagedAppDir,
          "resources/server.asar.unpacked/node_modules/native/addon.node",
        );
        yield* fs.remove(nativePath);
        yield* fs.makeDirectory(nativePath);

        const nativeError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(nativeError, WindowsPackagedPayloadValidationError);
        assert.equal(nativeError.reason, "unpacked-native-missing");
        assert.deepStrictEqual(nativeError.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);

        yield* fs.remove(nativePath, { recursive: true });
        yield* fs.writeFileString(nativePath, "native-binary");
        const resourceMonitorPath = path.join(
          fixture.packagedAppDir,
          "resources/resource-monitor/t3-resource-monitor.exe",
        );
        yield* fs.remove(resourceMonitorPath);
        yield* fs.makeDirectory(resourceMonitorPath);

        const resourceMonitorError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        }).pipe(Effect.flip);
        assert.instanceOf(resourceMonitorError, WindowsPackagedPayloadValidationError);
        assert.equal(resourceMonitorError.reason, "resource-monitor-missing");
        assert.deepStrictEqual(resourceMonitorError.missingFiles, [
          "resource-monitor/t3-resource-monitor.exe",
        ]);
      }),
    ),
  );

  it.effect("rejects a Windows payload that regresses above the file-count budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
          fileLimit: 2,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "file-limit-exceeded");
        assert.isAbove(error.fileCount ?? 0, 2);
      }),
    ),
  );

  it.effect("rejects a sidecar whose extracted server bundle cannot resolve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "t3code-deliberately-missing-package";\n',
        });
        const error = yield* verifyPackagedBundleIsSelfContained({
          asarPath: path.join(fixture.packagedAppDir, "resources", WINDOWS_SERVER_ASAR_RESOURCE),
          targetArch: "x64",
          verbose: false,
        }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Architecture, "x64"),
          Effect.flip,
        );

        assert.instanceOf(error, BundleNotSelfContainedError);
        assert.include(error.output, "t3code-deliberately-missing-package");
      }),
    ),
  );

  it.effect("leaves the bundle self-check of a cross-built payload to the verify job", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "t3code-deliberately-missing-package";\n',
        });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
          appVersion: WINDOWS_PAYLOAD_FIXTURE_VERSION,
        });
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcess.Platform, "linux"),
          Layer.succeed(HostProcess.Architecture, "x64"),
        ),
      ),
    ),
  );

  // regression: #145 fix(desktop): harden packaged runtime releases
  it.effect("fails closed when Electron Builder did not assemble the expected macOS app", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stageDistDir = yield* fs.makeTempDirectoryScoped({ prefix: "tritonai-dmg-test-" });
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];

      const error = yield* buildMacDmg({
        stageDistDir,
        version: "1.2.3",
        arch: "universal",
        verbose: false,
      }).pipe(Effect.provide(iconResizeSpawnerLayer(commands, [])), Effect.flip);

      assert.instanceOf(error, MacDesktopAppBundleMissingError);
      assert.include(error.appPath, "mac-universal/TritonAI Harness.app");
      assert.lengthOf(commands, 0);
    }),
  );

  it("derives macOS passkey signing configuration from the Clerk publishable key", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "abc1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
    });

    assert.deepStrictEqual(configuration, {
      appId: "edu.ucsd.tritonai.harness",
      teamId: "ABC1234567",
      rpDomains: ["example.clerk.accounts.dev"],
      provisioningProfilePath: "/tmp/t3code.provisionprofile",
    });
  });

  it("normalizes explicit macOS passkey RP domains and renders required entitlements", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS:
        " Clerk.Example.com,example.clerk.accounts.dev,clerk.example.com ",
    });
    const entitlements = renderMacPasskeyEntitlements(configuration, {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });

    assert.deepStrictEqual(configuration.rpDomains, [
      "clerk.example.com",
      "example.clerk.accounts.dev",
    ]);
    assert.include(entitlements, "<string>ABC1234567.edu.ucsd.tritonai.harness</string>");
    assert.include(entitlements, "<string>webcredentials:clerk.example.com</string>");
    assert.include(entitlements, "<string>webcredentials:example.clerk.accounts.dev</string>");
    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
    assert.match(entitlements, /<key>com\.apple\.security\.device\.camera<\/key>\s*<true\/>/u);
    assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/u);
    assert.notInclude(entitlements, "keychain-access-groups");
    assert.notInclude(entitlements, "com.apple.developer.web-browser.public-key-credential");
  });

  it("grants in-app browser passkey entitlements only when the provisioning profile does", () => {
    const configuration = { appId: "com.t3tools.t3code", teamId: "ABC1234567" };
    const profile = (entitlements: string, outside = "") =>
      `0\x82\x1f\x9a\x06\t*\x86H<?xml version="1.0"?><plist version="1.0"><dict>${outside}<key>Entitlements</key><dict>${entitlements}</dict></dict></plist>\x00\x01`;
    const teamWildcardGroups = `<key>keychain-access-groups</key>
      <array>
        <string>ABC1234567.*</string>
        <string>com.apple.token</string>
      </array>`;

    assert.deepStrictEqual(resolveMacWebAuthnEntitlements(profile(""), configuration), {
      touchIdKeychainAccessGroup: undefined,
      browserPasskeys: false,
    });
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile("<key>keychain-access-groups</key><array><string>OTHERTEAM1.*</string></array>"),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `<!-- ${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key><true/> -->
          <key>com.apple.developer.web-browser.public-key-credential</key><false/>`,
          teamWildcardGroups,
        ),
        configuration,
      ),
      { touchIdKeychainAccessGroup: undefined, browserPasskeys: false },
    );
    assert.deepStrictEqual(
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}
          <key>com.apple.developer.web-browser.public-key-credential</key>
          <true/>`,
        ),
        configuration,
      ),
      {
        touchIdKeychainAccessGroup: "ABC1234567.com.t3tools.t3code.webauthn",
        browserPasskeys: true,
      },
    );

    const entitlements = renderMacPasskeyEntitlements(
      { ...configuration, rpDomains: ["clerk.example.com"], provisioningProfilePath: "" },
      resolveMacWebAuthnEntitlements(
        profile(
          `${teamWildcardGroups}<key>com.apple.developer.web-browser.public-key-credential</key><true/>`,
        ),
        configuration,
      ),
    );
    assert.match(
      entitlements,
      /<key>keychain-access-groups<\/key>\s*<array>\s*<string>ABC1234567\.com\.t3tools\.t3code\.webauthn<\/string>\s*<\/array>/u,
    );
    assert.match(
      entitlements,
      /<key>com\.apple\.developer\.web-browser\.public-key-credential<\/key>\s*<true\/>/u,
    );
  });

  it("rejects incomplete macOS passkey signing configuration", () => {
    const captureError = (env: Readonly<Record<string, string | undefined>>) => {
      try {
        resolveMacPasskeySigningConfiguration(env);
      } catch (error) {
        return error;
      }
      return assert.fail("Expected passkey signing configuration to fail.");
    };

    const missingProfileError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev",
    });
    assert.instanceOf(missingProfileError, MissingMacPasskeyProvisioningProfileError);
    assert.equal(
      missingProfileError.message,
      "T3CODE_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.",
    );

    const unsafeDomain =
      "https://domain-user:domain-secret@example.clerk.accounts.dev/path?token=query-secret";
    const invalidDomainError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: unsafeDomain,
    });
    assert.instanceOf(invalidDomainError, InvalidMacPasskeyRpDomainError);
    assert.equal(invalidDomainError.reason, "scheme-not-allowed");
    assert.equal(invalidDomainError.inputLength, unsafeDomain.length);
    assert.equal(invalidDomainError.message, "Invalid passkey RP domain (scheme-not-allowed).");
    assert.notProperty(invalidDomainError, "domain");
    assert.notProperty(invalidDomainError, "cause");
    const serializedInvalidDomainError = JSON.stringify(invalidDomainError);
    assert.notInclude(serializedInvalidDomainError, unsafeDomain);
    assert.notInclude(serializedInvalidDomainError, "domain-user");
    assert.notInclude(serializedInvalidDomainError, "domain-secret");
    assert.notInclude(serializedInvalidDomainError, "query-secret");
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          T3CODE_APPLE_TEAM_ID: "ABC1234567",
          T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
          T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev:8443",
        }),
      /Invalid passkey RP domain/u,
    );
    const invalidPublishableKeyError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_%",
    });
    assert.instanceOf(invalidPublishableKeyError, InvalidMacPasskeyPublishableKeyError);
    assert.ok(invalidPublishableKeyError.cause);
    assert.equal(invalidPublishableKeyError.message, "T3CODE_CLERK_PUBLISHABLE_KEY is invalid.");
    assert.notProperty(invalidPublishableKeyError, "publishableKey");
    assert.notInclude(invalidPublishableKeyError.message, "pk_test_%");
  });

  it("wraps unknown passkey signing configuration defects without copying cause text", () => {
    const secret = "pk_test_do-not-retain";
    const cause = new Error(secret);
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(cause);

    assert.instanceOf(error, MacPasskeySigningConfigurationResolutionError);
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message, "Failed to resolve macOS passkey signing configuration.");
    assert.notInclude(error.message, secret);
  });

  // regression: #193 fix(desktop): retain microphone entitlements in release stages
  it.effect("keeps microphone entitlements in unsigned macOS release stages", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", false, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
        entitlementsInheritPath: "/tmp/entitlements.mac.inherit.plist",
      });

      const mac = config.mac as Record<string, unknown>;
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.equal(mac.entitlementsInherit, "/tmp/entitlements.mac.inherit.plist");
      assert.notProperty(mac, "provisioningProfile");
      assert.notProperty(mac, "sign");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("signs Windows builds with signtool on Windows and the jsign hook elsewhere", () =>
    Effect.gen(function* () {
      const signedWinConfig = (hostPlatform: string) =>
        createBuildConfig("win", "nsis", "1.2.3", true, false, undefined, undefined).pipe(
          Effect.map((config) => config.win as Record<string, unknown>),
          Effect.provideService(HostProcess.Platform, hostPlatform),
        );

      const onWindows = yield* signedWinConfig("win32");
      assert.equal((onWindows.azureSignOptions as Record<string, unknown>).publisherName, "T3");
      assert.notProperty(onWindows, "signtoolOptions");

      const onLinux = yield* signedWinConfig("linux");
      assert.notProperty(onLinux, "azureSignOptions");
      const signtoolOptions = onLinux.signtoolOptions as Record<string, unknown>;
      assert.match(signtoolOptions.sign as string, /scripts[\\/]lib[\\/]windows-jsign\.ts$/);
      assert.deepStrictEqual(signtoolOptions.signingHashAlgorithms, ["sha256"]);
      assert.deepStrictEqual(signtoolOptions.publisherName, ["T3"]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              AZURE_TENANT_ID: "tenant",
              AZURE_CLIENT_ID: "client",
              AZURE_CLIENT_SECRET: "secret",
              AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "T3",
              AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
              AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "profile",
              AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "account",
            },
          }),
        ),
      ),
    ),
  );

  it("parses Windows bsdtar member listings with CRLF line endings", () => {
    assert.deepStrictEqual(
      parseWslRuntimeArchiveMembers("./t3-1.2.3-linux-x64/t3\r\nt3-1.2.3-linux-x64/client/\r\n"),
      ["t3-1.2.3-linux-x64/t3", "t3-1.2.3-linux-x64/client"],
    );
  });

  it.effect("stages the Linux CLI archive verbatim with its SHA-256 sidecar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-wsl-runtime-stage-" });
        const sourceArchivePath = yield* makeLinuxCliArchiveFixture({
          root,
          stem: "t3-1.2.3-linux-x64",
        });
        const stageAppDir = path.join(root, "app");
        const archivePath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_EXTRA_RESOURCE.from);
        const hashPath = path.join(stageAppDir, WSL_RUNTIME_ARCHIVE_HASH_EXTRA_RESOURCE.from);

        yield* stageWslRuntimeArchive({ sourceArchivePath, archivePath, hashPath });

        const [source, staged] = yield* Effect.all([
          fs.readFile(sourceArchivePath),
          fs.readFile(archivePath),
        ]);
        assert.deepStrictEqual(staged, source);
        const hash = yield* fs.readFileString(hashPath);
        assert.equal(hash, `${NodeCrypto.createHash("sha256").update(source).digest("hex")}\n`);
      }),
    ),
  );

  // regression: #279 fix(desktop): keep the CUA asar loader patch in Windows packages
  it("keeps the asar-unpacked Cua Driver loader patch in staged installs", () => {
    const workspacePatches = {
      "@ubjs/node@0.31.0-3": "patches/@ubjs__node@0.31.0-3.patch",
      "sharp@0.35.0": "patches/sharp@0.35.0.patch",
    };
    const loaderDependencies = resolveCuaDriverPatchedLoaderDependencies(workspacePatches);
    assert.deepStrictEqual(loaderDependencies, { "@ubjs/node": "0.31.0-3" });
    assert.deepStrictEqual(createStagePatchedDependencies(workspacePatches, loaderDependencies), {
      "@ubjs/node@0.31.0-3": "patches/@ubjs__node@0.31.0-3.patch",
    });
  });

  // regression: #394 fix(release): preserve staged dependencies and align nightly checks
  it.effect("keeps deployed dependencies intact during the packager workspace probe in CI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "immutable-packaging-stage-" });
      const marker = path.join(root, "node_modules/retained-runtime/index.js");
      yield* fs.makeDirectory(path.dirname(marker), { recursive: true });
      yield* fs.writeFileString(marker, "deployed-runtime");
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "rewritten-packaging-stage",
          version: "1.0.0",
          private: true,
          packageManager: rootPackageJson.packageManager,
        }),
      );
      // A deployed lock retains source catalogs while packaging rewrites the
      // manifest/workspace. A workspace probe must never try to reinstall it.
      yield* fs.copyFile(
        NodePath.join(import.meta.dirname, "../pnpm-lock.yaml"),
        path.join(root, "pnpm-lock.yaml"),
      );
      yield* fs.writeFileString(
        path.join(root, "pnpm-workspace.yaml"),
        stringifyYaml(createStageWorkspaceConfig({ platform: "mac", arch: "arm64" })),
      );
      const command = yield* resolveSpawnCommand("vp", [
        "exec",
        "pnpm",
        "--workspace-root",
        "exec",
        process.execPath,
        "-e",
        "process.stdout.write('stage-probe')",
      ]);
      const child = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          cwd: root,
          shell: command.shell,
          env: { ...process.env, CI: "true" },
          stdout: "ignore",
          stderr: "pipe",
        }),
      );
      const [exitCode, stderr] = yield* Effect.all(
        [
          child.exitCode,
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(Number(exitCode), 0, stderr);
      assert.equal(yield* fs.readFileString(marker), "deployed-runtime");
    }),
  );

  // regression: #394 fix(release): preserve staged dependencies and align nightly checks
  it.effect("validates Windows FFI without requiring packed Linux addons to be unpacked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stageDistDir = yield* fs.makeTempDirectoryScoped({ prefix: "ffi-windows-layout-" });
      const sourceDir = path.join(stageDistDir, "source");
      const resources = path.join(stageDistDir, "win-unpacked/resources");
      const winFile = "node_modules/@yuuang/ffi-rs-win32-x64-msvc/ffi-rs.win32-x64-msvc.node";
      const linuxFile = "node_modules/@yuuang/ffi-rs-linux-x64-gnu/ffi-rs.linux-x64-gnu.node";
      for (const [file, header] of [
        [winFile, [0x4d, 0x5a]],
        [linuxFile, [0x7f, 0x45, 0x4c, 0x46]],
      ] as const) {
        yield* fs.makeDirectory(path.dirname(path.join(sourceDir, file)), { recursive: true });
        yield* fs.writeFile(path.join(sourceDir, file), new Uint8Array(header));
      }
      yield* fs.makeDirectory(resources, { recursive: true });
      const asarPath = path.join(resources, "server.asar");
      yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });
      assert.equal(yield* fs.exists(path.join(`${asarPath}.unpacked`, linuxFile)), false);
      assert.deepEqual(
        [...extractFile(asarPath, path.normalize(linuxFile))],
        [0x7f, 0x45, 0x4c, 0x46],
      );
      const options = {
        stageDistDir,
        platform: "win" as const,
        arch: "x64" as const,
        productName: "TritonAI Harness",
      };
      yield* assertPackagedFfiRsNativeBinaries(options);
      yield* fs.remove(path.join(`${asarPath}.unpacked`, winFile));
      const error = yield* assertPackagedFfiRsNativeBinaries(options).pipe(Effect.flip);
      assert.instanceOf(error, PackagedNativeDependencyMissingError);
      assert.equal(error.packageName, "@yuuang/ffi-rs-win32-x64-msvc");
    }),
  );

  // regression: #145 fix(desktop): harden packaged runtime releases
  it.effect("fails closed when an assembled app omits an ffi-rs native binary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stageDistDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tritonai-native-package-test-",
      });

      const error = yield* assertPackagedFfiRsNativeBinaries({
        stageDistDir,
        platform: "mac",
        arch: "arm64",
        productName: "TritonAI Harness",
      }).pipe(Effect.flip);

      assert.instanceOf(error, PackagedNativeDependencyMissingError);
      assert.equal(error.packageName, "@yuuang/ffi-rs-darwin-arm64");
      assert.include(
        error.binaryPath,
        "app.asar.unpacked/node_modules/@yuuang/ffi-rs-darwin-arm64",
      );
    }),
  );

  // regression: #155 fix(release): require packaged updater config
  it.effect("fails closed when assembled macOS and Windows apps omit updater config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stageDistDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tritonai-update-config-test-",
      });

      for (const input of [
        { platform: "mac", arch: "arm64" },
        { platform: "win", arch: "x64" },
      ] as const) {
        const error = yield* assertPackagedDesktopUpdateConfig({
          stageDistDir,
          ...input,
          productName: "TritonAI Harness",
        }).pipe(Effect.flip);

        assert.instanceOf(error, PackagedDesktopUpdateConfigMissingError);
        assert.equal(error.platform, input.platform);
        assert.equal(error.arch, input.arch);
        assert.equal(path.basename(error.configPath), "app-update.yml");
      }
    }),
  );

  it.effect("allows source staging only for a retained, externally finalized Mac ZIP", () =>
    Effect.gen(function* () {
      const input = {
        platform: Option.some("mac" as const),
        target: Option.some("zip"),
        arch: Option.some("arm64" as const),
        buildVersion: Option.none<string>(),
        outputDir: Option.none<string>(),
        skipBuild: Option.none<boolean>(),
        pluginConfigurationPrevalidated: Option.none<boolean>(),
        pluginValidationReceipt: Option.none<string>(),
        keepStage: Option.some(true),
        stageOnly: Option.some(true),
        signed: Option.some(false),
        verbose: Option.none<boolean>(),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none<number>(),
        wslRuntime: Option.none<string>(),
      };
      assert.equal((yield* resolveBuildOptions(input)).stageOnly, true);
      for (const invalid of [
        { keepStage: Option.some(false) },
        { arch: Option.some("x64" as const) },
        { signed: Option.some(true) },
        { target: Option.some("dmg") },
        { mockUpdates: Option.some(true) },
        { platform: Option.some("win" as const) },
      ]) {
        const error = yield* Effect.flip(resolveBuildOptions({ ...input, ...invalid }));
        assert.equal(error._tag, "InvalidDesktopStageOnlyOptionsError");
      }
    }),
  );

  it.effect("rejects universal builds on Linux and Windows before staging binaries", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "win"] as const) {
        const error = yield* Effect.flip(
          resolveBuildOptions({
            platform: Option.some(platform),
            target: Option.none(),
            arch: Option.some("universal"),
            buildVersion: Option.none(),
            outputDir: Option.none(),
            skipBuild: Option.none(),
            pluginConfigurationPrevalidated: Option.none(),
            pluginValidationReceipt: Option.none(),
            keepStage: Option.none(),
            stageOnly: Option.none(),
            signed: Option.none(),
            verbose: Option.none(),
            mockUpdates: Option.none(),
            mockUpdateServerPort: Option.none(),
            wslRuntime: Option.none(),
          }),
        );

        assert.instanceOf(error, UnsupportedDesktopBuildArchitectureError);
        assert.deepStrictEqual(error.supportedArchitectures, ["x64", "arm64"]);
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        pluginConfigurationPrevalidated: Option.some(false),
        pluginValidationReceipt: Option.none(),
        keepStage: Option.some(false),
        stageOnly: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        wslRuntime: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_PLUGIN_CONFIGURATION_PREVALIDATED: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_STAGE_ONLY: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.pluginConfigurationPrevalidated, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.stageOnly, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});

it("keeps the prefix of a UNC path instead of going relative", () => {
  const paths = ancestorNodeModulesPaths("\\\\server\\share\\tmp\\app", "\\");
  for (const candidate of paths) {
    assert.ok(candidate.startsWith("\\\\server\\share"), candidate);
  }
  assert.deepStrictEqual(paths[0], "\\\\server\\share\\tmp\\node_modules");
});

it.effect.skipIf(!symlinksSupported)("rebases packaged links into the isolated tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copy-symlinks-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const packageDir = path.join(source, "node_modules/.pnpm/example@1/node_modules/example");
    const relativePackageLink = path.join(source, "node_modules/example-relative");
    const absolutePackageLink = path.join(source, "node_modules/example-absolute");

    yield* fs.makeDirectory(packageDir, { recursive: true });
    yield* fs.writeFileString(path.join(packageDir, "index.js"), "module.exports = true;\n");
    yield* fs.symlink(
      path.join(".pnpm", "example@1", "node_modules", "example"),
      relativePackageLink,
    );
    yield* fs.symlink(packageDir, absolutePackageLink);

    yield* copyDirectoryPreservingSymlinks(source, destination);

    const copiedPackage = path.join(
      destination,
      "node_modules/.pnpm/example@1/node_modules/example",
    );
    const resolvedCopiedPackage = yield* fs.realPath(copiedPackage);
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-relative")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-absolute")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-relative")),
      resolvedCopiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-absolute")),
      resolvedCopiedPackage,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

// regression: #206 fix(release): unblock Windows builds and managed plugin startup
it.effect("enables Windows native deployment from either Mac host architecture", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const source = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
    const workspace = parseYaml(source) as {
      supportedArchitectures: Parameters<
        typeof findMissingRuntimeDeploymentArchitectures
      >[0]["configured"];
    };

    for (const hostArch of ["arm64", "x64"] as const) {
      assert.deepStrictEqual(
        findMissingRuntimeDeploymentArchitectures({
          configured: workspace.supportedArchitectures,
          hostPlatform: "darwin",
          hostArch,
          targetPlatform: "win",
          targetArch: "x64",
        }),
        [],
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

// regression: #134 fix: inherit macOS microphone entitlement
it("keeps hardened-runtime audio capabilities aligned for the main app and helpers", () => {
  const configuration = resolveMacPasskeySigningConfiguration({
    T3CODE_APPLE_TEAM_ID: "ABC1234567",
    T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
    T3CODE_CLERK_PASSKEY_RP_DOMAINS: "clerk.example.com",
  });
  const mainEntitlements = renderMacPasskeyEntitlements(configuration);
  const inheritedEntitlements = renderMacInheritedEntitlements();
  const hardenedRuntimeKeys = [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.device.audio-input",
  ];

  for (const key of hardenedRuntimeKeys) {
    assert.include(mainEntitlements, `<key>${key}</key>`);
    assert.include(inheritedEntitlements, `<key>${key}</key>`);
  }
  assert.notInclude(inheritedEntitlements, "com.apple.application-identifier");
  assert.notInclude(inheritedEntitlements, "com.apple.developer.associated-domains");
  assert.include(mainEntitlements, "com.apple.security.device.camera");
  assert.include(inheritedEntitlements, "com.apple.security.device.camera");
});
