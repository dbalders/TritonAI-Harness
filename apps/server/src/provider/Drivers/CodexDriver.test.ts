// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { layerTest as codexResetCreditLayerTest } from "../Layers/codexResetCredit.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import {
  createProviderVersionAdvisory,
  ProviderVersionCache,
  resolveLatestProviderVersion,
} from "../providerMaintenance.ts";
import { CodexDriver } from "./CodexDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-codex-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(codexResetCreditLayerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Codex must not make an HTTP request")),
    ),
  ),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Codex must not spawn a process"),
);

it.layer(testLayer)("CodexDriver", (it) => {
  it.effect.skipIf(windowsHost)(
    "runs the standalone updater against the shared home, not the shadow home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-driver-" })
          .pipe(Effect.flatMap(fs.realPath));
        const sharedHome = NodePath.join(tempDir, "codex-home");
        const shadowHome = NodePath.join(tempDir, "codex-shadow");
        const binaryPath = NodePath.join(sharedHome, "packages", "standalone", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-shadow"),
          displayName: "Codex test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          },
        });

        const capabilities = yield* instance.snapshot.resolveMaintenance();
        expect(capabilities.update).toMatchObject({
          executable: binaryPath,
          args: ["update"],
          lockKey: "codex-native",
          env: { CODEX_HOME: sharedHome },
        });
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const instance = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-missing"),
        displayName: "Codex test",
        enabled: false,
        environment: [],
        config: {
          ...CodexDriver.defaultConfig(),
          binaryPath: NodePath.join(NodeOS.tmpdir(), "t3-codex-missing", "codex"),
        },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  for (const fixture of [
    {
      name: "leaves mise npm-backend installations manual-only",
      installSegments: ["mise", "installs", "npm-openai-codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "leaves mise tool aliases backed by npm manual-only",
      installSegments: ["mise", "installs", "codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "keeps npm updates for globals in a mise Node installation",
      installSegments: ["mise", "installs", "node", "24.0.0"],
      npmOwned: true,
    },
    {
      name: "keeps npm updates for ordinary global installations",
      installSegments: ["npm-global"],
      npmOwned: true,
    },
  ] as const) {
    it.effect.skipIf(windowsHost)(fixture.name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-installer-" })
          .pipe(Effect.flatMap(fs.realPath));
        const installPath = NodePath.join(tempDir, ...fixture.installSegments);
        const realBinaryPath = NodePath.join(
          installPath,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        const binaryPath = NodePath.join(tempDir, "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(realBinaryPath), { recursive: true });
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(realBinaryPath, "#!/bin/sh\n");
        yield* fs.chmod(realBinaryPath, 0o755);
        yield* fs.symlink(realBinaryPath, binaryPath);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-installer"),
          displayName: "Codex installer test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        });

        const update = (yield* instance.snapshot.resolveMaintenance()).update;
        if (fixture.npmOwned) {
          expect(update).toMatchObject({
            executable: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              installPath,
              "--allow-scripts=@openai/codex",
              "@openai/codex@latest",
            ],
          });
        } else {
          expect(update).toBeNull();
        }
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    );
  }

  for (const layout of ["direct", "wrapper"] as const) {
    it.effect.skipIf(windowsHost)(`leaves a mise ${layout} installation manual-only`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: `t3-codex-mise-${layout}-` })
          .pipe(Effect.flatMap(fs.realPath));
        const binaryPath =
          layout === "direct"
            ? NodePath.join(tempDir, "mise", "installs", "codex", "0.110.0", "codex")
            : NodePath.join(tempDir, "omarchy", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(
          binaryPath,
          layout === "direct"
            ? "#!/bin/sh\n"
            : '#!/bin/sh\nmise use -g --quiet "codex" || exit 1\nexec mise x "codex" -- "codex" "$@"\n',
        );
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make(`codex-mise-${layout}`),
          displayName: "Codex mise test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        });

        expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    );
  }

  it.effect.each([
    {
      name: "conventional shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "custom data directory",
      dataRoot: "custom-tool-data",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "renamed configured command",
      dataRoot: "mise",
      commandName: "custom-codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "outdated provider",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.3",
      nodeFirst: false,
    },
    {
      name: "npm before shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: true,
    },
  ])(
    "does not mistake Homebrew mise for Codex's installer: $name",
    (fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-mise-shim-" })
          .pipe(Effect.flatMap(fs.realPath));
        const brewPrefix = NodePath.join(tempDir, "homebrew");
        const brewPath = NodePath.join(brewPrefix, "bin", "brew");
        const misePath = NodePath.join(brewPrefix, "Cellar", "mise", "2026.9.1", "bin", "mise");
        const shimDir = NodePath.join(tempDir, fixture.dataRoot, "shims");
        const npmPrefix = NodePath.join(tempDir, "mise", "installs", "node", "24.13.0");
        const npmBin = NodePath.join(npmPrefix, "bin");
        const npmEntry = NodePath.join(
          npmPrefix,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        for (const file of [brewPath, misePath, npmEntry]) {
          yield* fs.makeDirectory(NodePath.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "#!/bin/sh\n");
          yield* fs.chmod(file, 0o755);
        }
        yield* fs.makeDirectory(shimDir, { recursive: true });
        yield* fs.makeDirectory(npmBin, { recursive: true });
        yield* fs.symlink(misePath, NodePath.join(shimDir, fixture.commandName));
        yield* fs.symlink(npmEntry, NodePath.join(npmBin, fixture.commandName));
        const lookupPath = [
          ...(fixture.nodeFirst ? [npmBin, shimDir] : [shimDir, npmBin]),
          NodePath.dirname(brewPath),
        ].join(NodePath.delimiter);
        const probes: Array<ReadonlyArray<string>> = [];
        const metadataSpawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== brewPath) {
            return Effect.die("Provider resolution must not execute a provider or updater");
          }
          probes.push(command.args);
          const stdout =
            command.args[0] === "--prefix"
              ? brewPrefix
              : JSON.stringify({ formulae: [{ versions: { stable: "2026.9.1" } }] });
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(Stream.make(stdout)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-mise-shim"),
          displayName: "Codex shim test",
          enabled: false,
          environment: [{ name: "PATH", value: lookupPath, sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath: fixture.commandName,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, metadataSpawner));
        const capabilities = yield* instance.snapshot.resolveMaintenance();
        const latestVersion = yield* resolveLatestProviderVersion(capabilities).pipe(
          Effect.provideService(
            ProviderVersionCache,
            new Map([
              ["@openai/codex", { expiresAt: Number.MAX_SAFE_INTEGER, version: "0.153.4" }],
            ]),
          ),
        );
        expect(probes).toEqual([]);
        expect(latestVersion).toBe("0.153.4");
        expect(
          createProviderVersionAdvisory({
            driver: CodexDriver.driverKind,
            currentVersion: fixture.version,
            latestVersion,
            maintenanceCapabilities: capabilities,
          }),
        ).toMatchObject({
          status: fixture.version === "0.153.4" ? "current" : "behind_latest",
          currentVersion: fixture.version,
          latestVersion: "0.153.4",
          canUpdate: fixture.nodeFirst,
        });
        if (fixture.nodeFirst) {
          expect(capabilities.update).toMatchObject({
            executable: "npm",
            args: expect.arrayContaining(["--prefix", npmPrefix, "@openai/codex@latest"]),
          });
        } else {
          expect(capabilities.update).toBeNull();
        }
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );
});

import { assert, describe } from "@effect/vitest";

import { mergeCodexProviderEnvironment } from "./CodexDriver.ts";

describe("mergeCodexProviderEnvironment", () => {
  it("keeps the Usage-managed TritonAI key authoritative", () => {
    const environment = [
      { name: "TRITONAI_API_KEY", value: "stale-provider-key", sensitive: true },
      {
        name: "TRITONAI_API_KEY_SOURCE",
        value: "TRITONAI_ONPREM_API_KEY",
        sensitive: false,
      },
      { name: "UCSD_AI_BASE_URL", value: "https://tritonai.example/v1", sensitive: false },
    ];

    const result = mergeCodexProviderEnvironment(
      environment,
      { TRITONAI_API_KEY: "replacement-key", PATH: "/managed/bin" },
      "darwin",
      "codex",
    );

    assert.equal(result.TRITONAI_API_KEY, "replacement-key");
    assert.equal(result.UCSD_AI_BASE_URL, "https://tritonai.example/v1");
    assert.equal(result.PATH, "/managed/bin");
  });

  it("preserves a user-configured key on a non-managed Codex instance", () => {
    const result = mergeCodexProviderEnvironment(
      [
        { name: "TRITONAI_API_KEY", value: "personal-key", sensitive: true },
        { name: "TRITONAI_ONPREM_API_KEY", value: "personal-route-key", sensitive: true },
      ],
      { PATH: "/managed/bin" },
      "darwin",
      "codex_personal",
    );

    assert.equal(result.TRITONAI_API_KEY, "personal-key");
    assert.equal(result.TRITONAI_ONPREM_API_KEY, "personal-route-key");
  });

  it("does not leak inherited route credentials into a non-managed Codex instance", () => {
    const result = mergeCodexProviderEnvironment(
      undefined,
      {
        TRITONAI_ONPREM_API_KEY: "managed-on-prem-key",
        TRITONAI_FRONTIER_API_KEY: "managed-frontier-key",
        PATH: "/managed/bin",
      },
      "darwin",
      "codex_personal",
    );

    assert.notProperty(result, "TRITONAI_ONPREM_API_KEY");
    assert.notProperty(result, "TRITONAI_FRONTIER_API_KEY");
    assert.equal(result.PATH, "/managed/bin");
  });

  it("normalizes inherited Windows key casing when applying the managed key", () => {
    const result = mergeCodexProviderEnvironment(
      [
        { name: "tritonai_api_key", value: "stale-provider-key", sensitive: true },
        {
          name: "tritonai_api_key_source",
          value: "TRITONAI_ONPREM_API_KEY",
          sensitive: false,
        },
      ],
      { TRITONAI_API_KEY: "replacement-key" },
      "win32",
      "codex",
    );

    assert.equal(result.TRITONAI_API_KEY, "replacement-key");
    assert.notProperty(result, "tritonai_api_key");
  });

  it("selects the on-prem credential without exposing the frontier credential", () => {
    const result = mergeCodexProviderEnvironment(
      [
        {
          name: "TRITONAI_API_KEY_SOURCE",
          value: "TRITONAI_ONPREM_API_KEY",
          sensitive: false,
        },
      ],
      {
        TRITONAI_ONPREM_API_KEY: "on-prem-key",
        TRITONAI_FRONTIER_API_KEY: "frontier-key",
      },
      "darwin",
      "codex",
    );

    assert.equal(result.TRITONAI_API_KEY, "on-prem-key");
    assert.notProperty(result, "TRITONAI_ONPREM_API_KEY");
    assert.notProperty(result, "TRITONAI_FRONTIER_API_KEY");
    assert.notProperty(result, "TRITONAI_API_KEY_SOURCE");
  });

  it("selects the frontier credential and lets a shared key override both routes", () => {
    const routeEnvironment = [
      {
        name: "TRITONAI_API_KEY_SOURCE",
        value: "TRITONAI_FRONTIER_API_KEY",
        sensitive: false,
      },
    ];
    const routed = mergeCodexProviderEnvironment(
      routeEnvironment,
      {
        TRITONAI_ONPREM_API_KEY: "on-prem-key",
        TRITONAI_FRONTIER_API_KEY: "frontier-key",
      },
      "darwin",
      "codex_frontier",
    );
    const shared = mergeCodexProviderEnvironment(
      routeEnvironment,
      {
        TRITONAI_API_KEY: "shared-key",
        TRITONAI_FRONTIER_API_KEY: "frontier-key",
      },
      "darwin",
      "codex_frontier",
    );

    assert.equal(routed.TRITONAI_API_KEY, "frontier-key");
    assert.equal(shared.TRITONAI_API_KEY, "shared-key");
  });

  it("ignores unrecognized credential selectors", () => {
    const result = mergeCodexProviderEnvironment(
      [
        {
          name: "TRITONAI_API_KEY_SOURCE",
          value: "UNRELATED_SECRET",
          sensitive: false,
        },
      ],
      { UNRELATED_SECRET: "must-not-be-forwarded" },
      "darwin",
      "codex_personal",
    );

    assert.notProperty(result, "TRITONAI_API_KEY");
    assert.equal(result.UNRELATED_SECRET, "must-not-be-forwarded");
  });

  it("does not let a personal instance select a managed route credential", () => {
    const result = mergeCodexProviderEnvironment(
      [
        {
          name: "TRITONAI_API_KEY_SOURCE",
          value: "TRITONAI_FRONTIER_API_KEY",
          sensitive: false,
        },
      ],
      {
        TRITONAI_API_KEY: "managed-shared-key",
        TRITONAI_FRONTIER_API_KEY: "managed-frontier-key",
      },
      "darwin",
      "codex_personal",
    );

    assert.notProperty(result, "TRITONAI_API_KEY");
    assert.notProperty(result, "TRITONAI_FRONTIER_API_KEY");
    assert.notProperty(result, "TRITONAI_API_KEY_SOURCE");
  });
});
