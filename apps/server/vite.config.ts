import "vite-plus/test/config";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import {
  Architecture as HostProcessArchitecture,
  Platform as HostProcessPlatform,
} from "@t3tools/shared/HostProcess";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import {
  loadManagedPluginCompositionFromEnvironment,
  readManagedPluginBuildConfiguration,
} from "../../scripts/lib/managed-plugin-composition.ts";
import { loadManagedHarnessConfigForBuild } from "../../scripts/lib/managed-harness-config.ts";
import { loadHelpDocumentationForBuild } from "../../scripts/lib/help-documentation.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import { loadPluginSandboxBundleForBuild } from "../../scripts/lib/plugin-sandbox-bundle.ts";
import rootPackageJson from "../../package.json" with { type: "json" };
import packageJson from "./package.json" with { type: "json" };
import { WeightedShardSequencer } from "./src/testUtils/weightedShardSequencer.ts";

// NSIS install time tracks file count, not bytes.
import {
  isExternalCliDependency,
  shouldBundleCliDependency,
} from "../../scripts/lib/cli-external-packages.ts";

export { shouldBundleCliDependency };

const repoEnv = loadRepoEnv();
const repoRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const managedHarnessConfig = loadManagedHarnessConfigForBuild(repoRoot);
const managedPluginBuildInput = loadManagedPluginCompositionFromEnvironment(repoEnv);
const managedPluginComposition = managedPluginBuildInput?.composition ?? null;
const pluginSandboxBundle = loadPluginSandboxBundleForBuild(repoRoot, repoEnv);
const managedPluginConfiguration = managedPluginBuildInput
  ? readManagedPluginBuildConfiguration(managedPluginBuildInput.composition, repoEnv)
  : null;
// Memory sync signs in with the Microsoft 365 plugin's Entra app. A build
// without the plugin composition can name the app directly.
const microsoftOAuthConfiguration =
  managedPluginConfiguration?.["microsoft-365"] ??
  (repoEnv.TRITONAI_MICROSOFT_OAUTH_JSON?.trim()
    ? (JSON.parse(repoEnv.TRITONAI_MICROSOFT_OAUTH_JSON) as unknown)
    : null);
const cliBuildChannel = /^[^-+]+-(?:nightly|preview)\./.test(packageJson.version)
  ? "nightly"
  : "latest";
// Sent with every analytics event. Release workflows set it for pingdotgg/t3code
// builds only, so local builds and forks report "dev". A typo fails the build
// instead of mislabeling events.
const TELEMETRY_CHANNELS = ["stable", "nightly", "preview", "dev"];
const telemetryChannel = process.env.T3CODE_TELEMETRY_CHANNEL?.trim() || "dev";
if (!TELEMETRY_CHANNELS.includes(telemetryChannel)) {
  throw new Error(
    `T3CODE_TELEMETRY_CHANNEL must be one of ${TELEMETRY_CHANNELS.join(", ")}, got "${telemetryChannel}".`,
  );
}

// `build:exe` wraps the same bundle in a Node single-executable. tsdown's exe
// step refuses multi-chunk output and counts the sourcemap as a chunk, and the
// executable needs a host Node that supports `--build-sea` (25.7+), so this is
// a separate mode rather than a second entry in the default build.
const packExecutable = process.env.T3CODE_PACK_EXE === "1";
const SEA_TARGETS = {
  "darwin-arm64": { platform: "darwin", arch: "arm64" },
  "darwin-x64": { platform: "darwin", arch: "x64" },
  "linux-arm64": { platform: "linux", arch: "arm64" },
  "linux-x64": { platform: "linux", arch: "x64" },
  "win-arm64": { platform: "win", arch: "arm64" },
  "win-x64": { platform: "win", arch: "x64" },
} as const;
const [hostPlatform, hostArchitecture] = Effect.runSync(
  Effect.all([HostProcessPlatform, HostProcessArchitecture]),
);
const hostSeaPlatform = hostPlatform === "win32" ? "win" : hostPlatform;
const packExecutableTarget =
  process.env.T3CODE_PACK_EXE_TARGET?.trim() ||
  (packExecutable ? `${hostSeaPlatform}-${hostArchitecture}` : undefined);
const cliNodeVersion = rootPackageJson.engines.node;
if (
  packExecutable &&
  !process.env.T3CODE_PACK_EXE_TARGET?.trim() &&
  process.versions.node !== cliNodeVersion
) {
  throw new Error(
    `Native CLI executables must be built with Node ${cliNodeVersion}; running ${process.versions.node}.`,
  );
}
if (packExecutableTarget && !Object.hasOwn(SEA_TARGETS, packExecutableTarget)) {
  throw new Error(
    `T3CODE_PACK_EXE_TARGET must be one of ${Object.keys(SEA_TARGETS).join(", ")}, got "${packExecutableTarget}".`,
  );
}
const packExecutableTargets = packExecutableTarget
  ? [
      {
        ...SEA_TARGETS[packExecutableTarget as keyof typeof SEA_TARGETS],
        nodeVersion: cliNodeVersion,
      },
    ]
  : undefined;

// The root config's `projects` route repo-root runs to package configs,
// including this one. Inheriting them would make this config a container.
const { projects: _rootTestProjects, ...baseTestConfig } = baseConfig.test ?? {};

export default mergeConfig(
  { ...baseConfig, test: baseTestConfig },
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      // The executable embeds one entry; the history worker becomes a hidden
      // subcommand there instead of a sibling script.
      entry: packExecutable ? ["src/bin.ts"] : ["src/bin.ts", "src/claude-history-worker.ts"],
      outDir: packExecutable ? "dist-exe" : "dist",
      sourcemap: !packExecutable,
      clean: true,
      ...(packExecutable
        ? {
            exe: {
              fileName: "t3",
              outDir: "dist-exe",
              ...(packExecutableTargets ? { targets: packExecutableTargets } : {}),
              // Node's SEA docs: `import()` does not work when useCodeCache is
              // true, and the server reaches several modules that way.
              seaConfig: { useCodeCache: false },
            },
          }
        : {}),
      ...(packExecutable
        ? {
            // SEA only imports builtins. Bridge every disk-backed dependency,
            // including transitive imports such as platform-node's Undici,
            // through require while preserving the shared plugin runtime.
            plugins: [
              {
                name: "sea-external-runtime",
                resolveId(id, _importer, options) {
                  if (!isExternalCliDependency(id)) return;
                  return options.kind === "require-call"
                    ? { id, external: true }
                    : `\0sea-external-runtime:${id}.cjs`;
                },
                load(id) {
                  const prefix = "\0sea-external-runtime:";
                  if (!id.startsWith(prefix)) return;
                  return `module.exports = require(${JSON.stringify(id.slice(prefix.length, -4))});`;
                },
              },
            ],
          }
        : {}),
      deps: {
        // Both halves are required. `alwaysBundle` forces the JS dependencies in
        // (declared deps are external by default, which is what this change is
        // undoing). `neverBundle` forces the native packages out: returning
        // false from `alwaysBundle` only means "no opinion", so a transitive
        // dependency would still be bundled — which silently inlined native
        // loaders such as node-gyp-build, losing native acceleration.
        alwaysBundle: (id: string) =>
          (packExecutable && isExternalCliDependency(id)) || shouldBundleCliDependency(id),
        neverBundle: (id: string) => !packExecutable && isExternalCliDependency(id),
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: {
        __TRITONAI_HELP_DOCUMENTATION__: JSON.stringify(loadHelpDocumentationForBuild(repoRoot)),
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
        __TRITONAI_BUILD_SUPPORTS_INTEGRATION_FIXTURES__: "false",
        __TRITONAI_BUILD_PLUGIN_COMPOSITION__: JSON.stringify(managedPluginComposition),
        __TRITONAI_BUILD_PLUGIN_CONFIGURATION__: JSON.stringify(managedPluginConfiguration),
        __TRITONAI_BUILD_PLUGIN_SANDBOX__: JSON.stringify(pluginSandboxBundle?.manifest ?? null),
        __TRITONAI_BUILD_MICROSOFT_OAUTH__: JSON.stringify(microsoftOAuthConfiguration),
        __TRITONAI_BUILD_MANAGED_CONFIG__: JSON.stringify(managedHarnessConfig.config),
        __TRITONAI_BUILD_MANAGED_CONFIG_DIGEST__: JSON.stringify(managedHarnessConfig.digest),
        __T3CODE_TELEMETRY_CHANNEL__: JSON.stringify(telemetryChannel),
        __T3CODE_BUILD_RELAY_URL__: JSON.stringify(repoEnv.T3CODE_RELAY_URL?.trim() ?? ""),
        __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
          repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
        ),
        __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
          repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
          repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "",
        ),
      },
    },
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      sequence: { sequencer: WeightedShardSequencer },
      // Appended to the root setup, which mergeConfig concatenates.
      setupFiles: ["./src/testUtils/gitConfig.setup.ts"],
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
