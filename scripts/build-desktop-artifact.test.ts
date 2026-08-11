import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  assertPackagedFfiRsNativeBinaries,
  buildMacDmg,
  BuildCommandFailedError,
  createStageWorkspaceConfig,
  createDesktopSourceBuildEnvironment,
  findMissingRuntimeDeploymentArchitectures,
  createStagePatchedDependencies,
  createBuildConfig,
  DESKTOP_MANAGED_PLUGIN_FILE_SET,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_EXTRA_RESOURCES,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  InvalidAzureTrustedSigningEndpointError,
  InvalidMockUpdateServerPortError,
  UnsupportedDesktopBuildArchitectureError,
  isMacPasskeySigningConfigurationError,
  LinuxIconResizeError,
  MacDesktopAppBundleMissingError,
  MacPasskeySigningConfigurationResolutionError,
  MissingAzureTrustedSigningConfigurationError,
  MissingMacPasskeyProvisioningProfileError,
  PackagedNativeDependencyMissingError,
  renderMacInheritedEntitlements,
  renderMacPasskeyEntitlements,
  resolveClerkPasskeyNativeArtifacts,
  resolveMacPasskeySigningConfiguration,
  resolveDesktopRuntimeDependencies,
  resolveFffNativeDependencies,
  resolveFfiRsNativeArtifacts,
  resolveFfiRsNativeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveResourceMonitorRustTargets,
  resourceMonitorExecutableName,
  RUNTIME_DEPLOY_ARGS,
  resolveGitHubPublishConfig,
  resolveMacAppBundleDirectoryName,
  resolveMacDmgArtifactName,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  resolveAzureTrustedSigningConfiguration,
  resolvePackageManagerUserAgent,
  stageLinuxIconSize,
  validateManagedPluginBuildConfiguration,
  WINDOWS_ASAR_UNPACK,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

function mockProcess(exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

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

it("builds the server from the frozen managed plugin snapshot and validated configuration", () => {
  const environment = createDesktopSourceBuildEnvironment(
    {
      TRITONAI_PLUGIN_COMPOSITION_SOURCE: "/moving/source",
      TRITONAI_PLUGIN_CONFIGURATION_JSON: '{"stale":true}',
      AZURE_CLIENT_SECRET: "must-not-reach-the-source-build",
      KEEP_ME: "yes",
    },
    {
      sourceRoot: "/frozen/plugin-composition-input",
      serializedConfiguration: '{"microsoft-365":{"clientId":"public-client"}}',
    },
  );

  assert.equal(environment.TRITONAI_PLUGIN_COMPOSITION_SOURCE, "/frozen/plugin-composition-input");
  assert.equal(
    environment.TRITONAI_PLUGIN_CONFIGURATION_JSON,
    '{"microsoft-365":{"clientId":"public-client"}}',
  );
  assert.notProperty(environment, "AZURE_CLIENT_SECRET");
  assert.equal(environment.KEEP_ME, "yes");
});

it("removes ambient managed plugin inputs from builds without a frozen composition", () => {
  const environment = createDesktopSourceBuildEnvironment(
    {
      TRITONAI_PLUGIN_COMPOSITION_SOURCE: "/ambient/source",
      TRITONAI_PLUGIN_CONFIGURATION_JSON: '{"ambient":true}',
      KEEP_ME: "yes",
    },
    null,
  );

  assert.notProperty(environment, "TRITONAI_PLUGIN_COMPOSITION_SOURCE");
  assert.notProperty(environment, "TRITONAI_PLUGIN_CONFIGURATION_JSON");
  assert.equal(environment.KEEP_ME, "yes");
});

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

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "TritonAI Harness");
    assert.equal(
      resolveDesktopProductName("0.0.17-nightly.20260413.42"),
      "TritonAI Harness (Nightly)",
    );
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("switches the bundled splash and favicon branding for nightly versions", () => {
    assert.equal(resolveDesktopWebAssetBrand("0.0.17"), "production");
    assert.equal(resolveDesktopWebAssetBrand("0.0.17-nightly.20260413.42"), "nightly");
  });

  it.effect("resolves GitHub desktop publish config from Effect config", () =>
    Effect.gen(function* () {
      const latestConfig = yield* resolveGitHubPublishConfig("latest").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );
      const nightlyConfig = yield* resolveGitHubPublishConfig("nightly").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(latestConfig, {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "release",
      });
      assert.deepStrictEqual(nightlyConfig, {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "prerelease",
        channel: "nightly",
      });
    }),
  );

  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@t3tools/contracts": "workspace:*",
          "@t3tools/shared": "workspace:*",
          "@t3tools/ssh": "workspace:*",
          "@t3tools/tailscale": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
        effect: "4.0.0-beta.59",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        {
          "@ff-labs/fff-node": "0.9.4",
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.73",
        },
      ),
      {
        "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
        "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
        "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
      },
    );

    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.73" },
      ),
      {},
    );
  });

  it("installs optional native dependencies for the target desktop architecture", () => {
    assert.deepStrictEqual(RUNTIME_DEPLOY_ARGS, [
      "exec",
      "pnpm",
      "--config.inject-workspace-packages=true",
      "--filter",
      "@t3tools/desktop-runtime",
      "deploy",
      "--prod",
      "--frozen-lockfile",
    ]);
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "x64" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["x64"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "linux", arch: "x64" }), {
      supportedArchitectures: {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
    });
    // Windows artifacts also bundle the same-architecture WSL (Linux, glibc) backend, so the
    // staged install must fetch its native optional deps (e.g. ffi-rs) too.
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "x64" }), {
      supportedArchitectures: {
        os: ["win32", "linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "arm64" }), {
      supportedArchitectures: {
        os: ["win32", "linux"],
        cpu: ["arm64"],
        libc: ["glibc"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "universal" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["arm64", "x64"],
      },
    });
    assert.deepStrictEqual(
      findMissingRuntimeDeploymentArchitectures({
        configured: {
          os: ["current", "linux"],
          cpu: ["current", "x64"],
          libc: ["current", "glibc"],
        },
        hostPlatform: "win32",
        hostArch: "x64",
        targetPlatform: "win",
        targetArch: "x64",
      }),
      [],
    );
    assert.deepStrictEqual(
      findMissingRuntimeDeploymentArchitectures({
        configured: {
          os: ["current", "linux"],
          cpu: ["current", "x64"],
          libc: ["current", "glibc"],
        },
        hostPlatform: "darwin",
        hostArch: "arm64",
        targetPlatform: "win",
        targetArch: "x64",
      }),
      ["os:win32"],
    );
    assert.deepStrictEqual(
      findMissingRuntimeDeploymentArchitectures({
        configured: {
          os: ["current", "win32"],
          cpu: ["current"],
          libc: ["current"],
        },
        hostPlatform: "linux",
        hostArch: "x64",
        hostLibc: "glibc",
        targetPlatform: "win",
        targetArch: "x64",
      }),
      [],
    );
  });

  it("stages pnpm 11 allowBuilds and patchedDependencies in the workspace yaml", () => {
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "linux",
        arch: "x64",
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      }),
      {
        supportedArchitectures: {
          os: ["linux"],
          cpu: ["x64"],
          libc: ["glibc"],
        },
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      },
    );

    // Empty maps must not be written — pnpm would still require reviewed
    // packages if allowBuilds is present but incomplete, and omitting empty
    // patchedDependencies keeps the stage yaml minimal.
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "mac",
        arch: "arm64",
        allowBuilds: {},
        patchedDependencies: {},
        overrides: {},
      }),
      {
        supportedArchitectures: {
          os: ["darwin"],
          cpu: ["arm64"],
        },
      },
    );
  });

  it("limits Electron locales and excludes the unused Claude SDK executable", () => {
    assert.deepStrictEqual(DESKTOP_ELECTRON_LANGUAGES, ["en-US"]);
    assert.deepStrictEqual(DESKTOP_FILE_EXCLUSIONS, [
      "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
    ]);
  });

  it.effect("applies platform-specific packaging to the build config", () =>
    Effect.gen(function* () {
      const mac = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      const win = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );

      assert.deepStrictEqual(DESKTOP_MANAGED_PLUGIN_FILE_SET, {
        from: "apps/server/dist/production-integrations",
        to: "apps/server/dist/production-integrations",
        filter: ["**/*"],
      });
      assert.notProperty(mac, "asarUnpack");
      assert.deepStrictEqual((mac.mac as Record<string, unknown>).target, ["zip"]);
      assert.notProperty(linux, "asarUnpack");
      assert.deepStrictEqual(win.asarUnpack, WINDOWS_ASAR_UNPACK);
      for (const config of [mac, linux, win]) {
        assert.deepStrictEqual(config.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
        assert.deepStrictEqual(config.files, [
          "**/*",
          ...DESKTOP_FILE_EXCLUSIONS,
          DESKTOP_MANAGED_PLUGIN_FILE_SET,
        ]);
      }
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("preserves both Linux icon resize failures with structural context", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const error = yield* stageLinuxIconSize("source.png", "target.png", 512, false).pipe(
        Effect.provide(iconResizeSpawnerLayer(commands, [1, 2])),
        Effect.flip,
      );

      assert.instanceOf(error, LinuxIconResizeError);
      assert.equal(error.operation, "resize");
      assert.equal(error.iconSize, 512);
      assert.equal(error.primaryTool, "magick");
      assert.equal(error.fallbackTool, "convert");
      assert.include(error.message, "512x512");
      assert.include(error.message, "`magick`");
      assert.include(error.message, "`convert`");
      assert.notInclude(error.message, "non-zero exit code");

      assert.instanceOf(error.cause, AggregateError);
      const aggregateCause = error.cause as AggregateError;
      assert.lengthOf(aggregateCause.errors, 2);
      assert.strictEqual(aggregateCause.cause, aggregateCause.errors[0]);
      assert.instanceOf(aggregateCause.errors[0], BuildCommandFailedError);
      assert.instanceOf(aggregateCause.errors[1], BuildCommandFailedError);
      const primaryError = aggregateCause.errors[0] as BuildCommandFailedError;
      const fallbackError = aggregateCause.errors[1] as BuildCommandFailedError;
      assert.equal(primaryError.command, "magick linux icon 512x512");
      assert.equal(primaryError.exitCode, 1);
      assert.include(primaryError.message, "magick linux icon");
      assert.equal(fallbackError.command, "convert linux icon 512x512");
      assert.equal(fallbackError.exitCode, 2);
      assert.include(fallbackError.message, "convert linux icon");
      assert.deepStrictEqual(
        commands.map(({ command }) => command),
        ["magick", "convert"],
      );
    });
  });

  it("resolves the assembled macOS app and native DMG names for every architecture", () => {
    assert.equal(resolveMacAppBundleDirectoryName("arm64"), "mac-arm64");
    assert.equal(resolveMacAppBundleDirectoryName("x64"), "mac");
    assert.equal(resolveMacAppBundleDirectoryName("universal"), "mac-universal");
    assert.equal(resolveMacDmgArtifactName("1.2.3", "arm64"), "TritonAI-Harness-1.2.3-arm64.dmg");
    assert.equal(resolveMacDmgArtifactName("1.2.3", "x64"), "TritonAI-Harness-1.2.3-x64.dmg");
    assert.equal(
      resolveMacDmgArtifactName("1.2.3", "universal"),
      "TritonAI-Harness-1.2.3-universal.dmg",
    );

    const missingApp = new MacDesktopAppBundleMissingError({
      appPath: "/tmp/mac-arm64/TritonAI Harness.app",
      arch: "arm64",
    });
    assert.include(missingApp.message, "/tmp/mac-arm64/TritonAI Harness.app");
  });

  it.effect("stages DMGs through ditto and hdiutil without a mounted-volume copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stageDistDir = yield* fs.makeTempDirectoryScoped({ prefix: "tritonai-dmg-test-" });
      const appPath = path.join(stageDistDir, "mac-arm64", "TritonAI Harness.app");
      yield* fs.makeDirectory(appPath, { recursive: true });
      const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
        [];

      const dmgPath = yield* buildMacDmg({
        stageDistDir,
        version: "1.2.3",
        arch: "arm64",
        verbose: false,
      }).pipe(Effect.provide(iconResizeSpawnerLayer(commands, [0, 0])));

      assert.equal(dmgPath, path.join(stageDistDir, "TritonAI-Harness-1.2.3-arm64.dmg"));
      assert.equal(commands[0]?.command, "/usr/bin/ditto");
      assert.deepStrictEqual(commands[0]?.args.slice(0, 2), ["--noextattr", "--noqtn"]);
      assert.equal(commands[0]?.args[2], appPath);
      assert.equal(commands[1]?.command, "/usr/bin/hdiutil");
      const hdiutilArgs = commands[1]?.args ?? [];
      for (const argument of ["create", "-srcfolder", "-format", "UDZO", dmgPath]) {
        assert.include(hdiutilArgs, argument);
      }
      assert.notInclude(hdiutilArgs, "attach");
    }),
  );

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

  it.effect("creates a real native DMG from a staged macOS app", () =>
    Effect.gen(function* () {
      const hostPlatform = yield* HostProcessPlatform;
      if (hostPlatform !== "darwin") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stageDistDir = yield* fs.makeTempDirectoryScoped({
        prefix: "tritonai-native-dmg-test-",
      });
      const contentsPath = path.join(stageDistDir, "mac-arm64", "TritonAI Harness.app", "Contents");
      yield* fs.makeDirectory(contentsPath, { recursive: true });
      yield* fs.writeFileString(
        path.join(contentsPath, "Info.plist"),
        '<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>\n',
      );

      const dmgPath = yield* buildMacDmg({
        stageDistDir,
        version: "1.2.3",
        arch: "arm64",
        verbose: false,
      });
      const stat = yield* fs.stat(dmgPath);

      assert.equal(stat.type, "File");
      assert.isAbove(Number(stat.size), 0);
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
    const entitlements = renderMacPasskeyEntitlements(configuration);

    assert.deepStrictEqual(configuration.rpDomains, [
      "clerk.example.com",
      "example.clerk.accounts.dev",
    ]);
    assert.include(entitlements, "<string>ABC1234567.edu.ucsd.tritonai.harness</string>");
    assert.include(entitlements, "<string>webcredentials:clerk.example.com</string>");
    assert.include(entitlements, "<string>webcredentials:example.clerk.accounts.dev</string>");
    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
    assert.include(entitlements, "<key>com.apple.security.device.audio-input</key>");
  });

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
    assert.notInclude(mainEntitlements, "com.apple.security.device.camera");
    assert.notInclude(inheritedEntitlements, "com.apple.security.device.camera");
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

  it("preserves known passkey signing configuration errors at the build boundary", () => {
    const decodingCause = new Error("publishable-key-decode-failed");
    const knownError = new InvalidMacPasskeyPublishableKeyError({ cause: decodingCause });
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(knownError);

    assert.strictEqual(error, knownError);
    assert.instanceOf(error, InvalidMacPasskeyPublishableKeyError);
    assert.strictEqual(error.cause, decodingCause);
    assert.isTrue(isMacPasskeySigningConfigurationError(error));
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

  it.effect("adds passkey entitlements and both renderer protocols to signed macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
        entitlementsInheritPath: "/tmp/entitlements.mac.inherit.plist",
        provisioningProfilePath: "/tmp/t3code.provisionprofile",
      });

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "edu.ucsd.tritonai.harness");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.equal(mac.entitlementsInherit, "/tmp/entitlements.mac.inherit.plist");
      assert.equal(mac.provisioningProfile, "/tmp/t3code.provisionprofile");
      assert.deepNestedInclude(mac, {
        extendInfo: {
          NSMicrophoneUsageDescription:
            "TritonAI Harness uses the microphone for voice dictation in the composer.",
        },
      });
      assert.deepStrictEqual(mac.protocols, [
        { name: "TritonAI Harness", schemes: ["t3code", "t3code-dev"] },
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("keeps executable resource editing enabled for unsigned Windows builds", () =>
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

  it.effect("keeps Authenticode verification strict and publisher-bound", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const source = yield* fs.readFileString(
        path.join(repoRoot, "scripts/verify-windows-authenticode.ps1"),
      );

      assert.include(source, "Get-AuthenticodeSignature -LiteralPath");
      assert.include(source, "SignatureStatus]::Valid");
      assert.include(source, "$PublisherName -cne $ExpectedPublisherName");
      assert.include(source, "FromBase64String($EncodedPaths)");
    }),
  );

  it.effect("keeps the Windows process check exact, case-insensitive, and injection-safe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const source = yield* fs.readFileString(
        path.join(repoRoot, "apps/desktop/resources/installer.nsh"),
      );
      const powerShellLines = source.split("\n").filter((line) => line.includes("$PowerShellPath"));

      assert.include(source, "!macro customCheckAppRunning");
      assert.include(source, "TRITONAI_NSIS_TARGET_EXECUTABLE");
      assert.include(source, "$$_.ExecutablePath");
      assert.include(source, "[System.StringComparison]::OrdinalIgnoreCase");
      assert.include(source, "${isUpdated}");
      assert.include(source, "MB_OKCANCEL|MB_ICONEXCLAMATION");
      assert.include(source, "Stop-Process -Id $$proc.ProcessId -ErrorAction Stop");
      assert.include(source, "Stop-Process -Id $$proc.ProcessId -Force -ErrorAction Stop");
      assert.include(source, "MB_RETRYCANCEL|MB_ICONEXCLAMATION");
      assert.include(source, "${if} $0 == 1");
      assert.include(source, "catch { exit 2 }");
      assert.isAtLeast(
        source.match(/Get-CimInstance -ClassName Win32_Process -ErrorAction Stop/g)?.length ?? 0,
        4,
      );
      assert.isAtLeast(powerShellLines.length, 2);
      for (const powerShellLine of powerShellLines) {
        assert.notInclude(powerShellLine, "$INSTDIR");
      }
      assert.notInclude(source, "$$_.Path");
    }),
  );

  it.effect("swaps the Windows install directory atomically and keeps rollback recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const source = yield* fs.readFileString(
        path.join(repoRoot, "apps/desktop/resources/installer.nsh"),
      );

      assert.include(source, "!macro customRemoveFiles");
      assert.include(source, "!macro customInit");
      assert.include(source, "!macro customInstall");
      assert.include(source, "Function .onInstFailed");
      assert.include(source, 'Rename "$INSTDIR" "$INSTDIR.old"');
      assert.include(source, 'Rename "$INSTDIR.old" "$INSTDIR"');
      assert.include(source, 'RMDir /r /REBOOTOK "$INSTDIR.old"');
      assert.include(source, '!define TRITONAI_APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"');
      assert.include(
        source,
        '!define TRITONAI_INSTALL_COMPLETE_MARKER ".tritonai-install-complete"',
      );
      assert.include(source, 'FileOpen $0 "$INSTDIR\\${TRITONAI_INSTALL_COMPLETE_MARKER}" w');
      assert.include(
        source,
        'File /oname=$PLUGINSDIR\\tritonai-upgrade-uninstaller.exe "${UNINSTALLER_OUT_FILE}"',
      );
      assert.match(
        source,
        /!ifndef BUILD_UNINSTALLER[\s\S]*?File \/oname=\$PLUGINSDIR\\tritonai-upgrade-uninstaller\.exe "\$\{UNINSTALLER_OUT_FILE\}"[\s\S]*?!endif/u,
      );
      assert.include(
        source,
        'CopyFiles /SILENT "$PLUGINSDIR\\tritonai-upgrade-uninstaller.exe" "$INSTDIR\\${UNINSTALL_FILENAME}"',
      );
      assert.include(
        source,
        'IfFileExists "$INSTDIR\\${TRITONAI_INSTALL_COMPLETE_MARKER}" restoreComplete 0',
      );
      assert.include(
        source,
        'IfFileExists "$INSTDIR.old\\${TRITONAI_APP_EXECUTABLE_FILENAME}" 0 restoreComplete',
      );
      assert.include(source, "${if} ${isUpdated}");
      assert.include(source, 'RMDir /r "$INSTDIR"');
      assert.notInclude(source, "$PLUGINSDIR\\old-install");
    }),
  );

  it("keeps the managed config in the app while staging the resource monitor externally", () => {
    assert.deepStrictEqual(DESKTOP_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/prod-resources/resource-monitor",
        to: "resource-monitor",
      },
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("mac", "universal"), [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("linux", "x64"), [
      "x86_64-unknown-linux-gnu",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("win", "arm64"), [
      "aarch64-pc-windows-msvc",
    ]);
    assert.equal(resourceMonitorExecutableName("mac"), "t3-resource-monitor");
    assert.equal(resourceMonitorExecutableName("win"), "t3-resource-monitor.exe");
  });
  it("promotes target fff binaries to direct staged dependencies", () => {
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "universal", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      "@ff-labs/fff-bin-darwin-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("win", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-win32-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-arm64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-arm64-musl": "0.9.4",
    });
  });

  it("promotes exact target ffi-rs native packages to direct staged dependencies", () => {
    assert.deepStrictEqual(resolveFfiRsNativeDependencies("mac", "arm64", "1.3.2"), {
      "@yuuang/ffi-rs-darwin-arm64": "1.3.2",
    });
    assert.deepStrictEqual(resolveFfiRsNativeDependencies("mac", "universal", "1.3.2"), {
      "@yuuang/ffi-rs-darwin-arm64": "1.3.2",
      "@yuuang/ffi-rs-darwin-x64": "1.3.2",
    });
    assert.deepStrictEqual(resolveFfiRsNativeDependencies("win", "x64", "1.3.2"), {
      "@yuuang/ffi-rs-win32-x64-msvc": "1.3.2",
      "@yuuang/ffi-rs-linux-x64-gnu": "1.3.2",
    });
    assert.deepStrictEqual(resolveFfiRsNativeArtifacts("linux", "arm64"), [
      {
        packageName: "@yuuang/ffi-rs-linux-arm64-gnu",
        binaryFileName: "ffi-rs.linux-arm64-gnu.node",
      },
    ]);
  });

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

  it("resolves target Clerk passkey native artifacts", () => {
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("mac", "universal"), [
      {
        packageName: "@clerk/electron-passkeys-darwin-arm64",
        binaryFileName: "electron-passkeys.darwin-arm64.node",
      },
      {
        packageName: "@clerk/electron-passkeys-darwin-x64",
        binaryFileName: "electron-passkeys.darwin-x64.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("win", "x64"), [
      {
        packageName: "@clerk/electron-passkeys-win32-x64-msvc",
        binaryFileName: "electron-passkeys.win32-x64-msvc.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("linux", "x64"), []);
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it("derives the electron-builder package manager user agent from packageManager", () => {
    assert.equal(resolvePackageManagerUserAgent("pnpm@11.10.0"), "pnpm/11.10.0");
    assert.equal(resolvePackageManagerUserAgent(" yarn@4.9.2 "), "yarn/4.9.2");
    assert.equal(resolvePackageManagerUserAgent("pnpm"), "pnpm");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it("classifies invalid configured ports with the decoder's number grammar", () => {
    const cause = new Error("invalid configured port");

    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).reason,
      "not-numeric",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("12.5", cause).reason,
      "not-integer",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("65536", cause).reason,
      "out-of-range",
    );
    assert.strictEqual(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).cause,
      cause,
    );
  });

  it.effect("resolves default platform and architecture from host references", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        pluginConfigurationPrevalidated: Option.none(),
        pluginValidationReceipt: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
        wslPrebuild: Option.none(),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "win32"),
            Layer.succeed(HostProcessArchitecture, "x64"),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PROCESSOR_ARCHITECTURE: "AMD64",
                  PROCESSOR_ARCHITEW6432: "ARM64",
                },
              }),
            ),
          ),
        ),
      );

      assert.equal(resolved.platform, "win");
      assert.equal(resolved.target, "nsis");
      assert.equal(resolved.arch, "arm64");
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
            signed: Option.none(),
            verbose: Option.none(),
            mockUpdates: Option.none(),
            mockUpdateServerPort: Option.none(),
            wslPrebuild: Option.none(),
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
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        wslPrebuild: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_PLUGIN_CONFIGURATION_PREVALIDATED: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
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
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
