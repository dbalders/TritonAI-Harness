// @effect-diagnostics nodeBuiltinImport:off
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import {
  resolveSpawnCommand,
  SpawnExecutableResolution,
  type CommandAvailabilityOptions,
  type ResolvedSpawnCommand,
} from "@t3tools/shared/shell";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const CODEX_MANAGED_PACKAGE_ROOT = "CODEX_MANAGED_PACKAGE_ROOT";
const CODEX_MANAGED_BY_NPM = "CODEX_MANAGED_BY_NPM";
const CODEX_MANAGED_BY_BUN = "CODEX_MANAGED_BY_BUN";
const CODEX_MANAGED_BY_PNPM = "CODEX_MANAGED_BY_PNPM";
const CODEX_MANAGED_ENV_NAMES = [
  CODEX_MANAGED_PACKAGE_ROOT,
  CODEX_MANAGED_BY_NPM,
  CODEX_MANAGED_BY_BUN,
  CODEX_MANAGED_BY_PNPM,
] as const;

interface WindowsCodexTarget {
  readonly packageName: "codex-win32-arm64" | "codex-win32-x64";
  readonly triple: "aarch64-pc-windows-msvc" | "x86_64-pc-windows-msvc";
}

export interface ResolvedCodexAppServerCommand extends ResolvedSpawnCommand {
  readonly environment: NodeJS.ProcessEnv;
}

export type CodexNativeExecutableProbe = (filePath: string) => boolean;

function isFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export const CodexNativeExecutableAvailability = Context.Reference<CodexNativeExecutableProbe>(
  "@t3tools/server/CodexNativeExecutableAvailability",
  { defaultValue: () => isFile },
);

function windowsCodexTarget(architecture: NodeJS.Architecture): WindowsCodexTarget | undefined {
  if (architecture === "x64") {
    return {
      packageName: "codex-win32-x64",
      triple: "x86_64-pc-windows-msvc",
    };
  }
  if (architecture === "arm64") {
    return {
      packageName: "codex-win32-arm64",
      triple: "aarch64-pc-windows-msvc",
    };
  }
  return undefined;
}

function readEnvironmentValueCaseInsensitive(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const normalizedName = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === normalizedName) return value;
  }
  return undefined;
}

function inferCodexPackageRoots(command: string, env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const configuredPackageRoot = readEnvironmentValueCaseInsensitive(
    env,
    CODEX_MANAGED_PACKAGE_ROOT,
  )?.trim();
  const path = NodePath.win32;
  const baseName = path.basename(command).toLowerCase();
  if (baseName === "codex.cmd" || baseName === "codex.bat") {
    const shimDirectory = path.dirname(command);
    return [
      path.join(shimDirectory, "lib", "node_modules", "@openai", "codex"),
      path.join(shimDirectory, "node_modules", "@openai", "codex"),
      ...(configuredPackageRoot ? [configuredPackageRoot] : []),
    ];
  }

  if (
    baseName === "codex.js" &&
    path.basename(path.dirname(command)).toLowerCase() === "bin" &&
    path.basename(path.dirname(path.dirname(command))).toLowerCase() === "codex"
  ) {
    const packageRoot = path.dirname(path.dirname(command));
    return [
      packageRoot,
      ...(configuredPackageRoot && configuredPackageRoot !== packageRoot
        ? [configuredPackageRoot]
        : []),
    ];
  }

  return [];
}

function nativeCodexCandidates(
  packageRoot: string,
  target: WindowsCodexTarget,
): ReadonlyArray<string> {
  const path = NodePath.win32;
  const platformPackage = `@openai/${target.packageName}`;
  const executableSuffix = path.join("vendor", target.triple, "bin", "codex.exe");
  const nodeModulesRoot = path.dirname(path.dirname(packageRoot));

  return [
    path.join(packageRoot, "node_modules", platformPackage, executableSuffix),
    path.join(nodeModulesRoot, platformPackage, executableSuffix),
    path.join(packageRoot, executableSuffix),
  ];
}

export function resolveNativeWindowsCodex(
  command: string,
  architecture: NodeJS.Architecture,
  env: NodeJS.ProcessEnv,
  available: CodexNativeExecutableProbe,
): { readonly command: string; readonly packageRoot: string } | undefined {
  const target = windowsCodexTarget(architecture);
  if (!target) return undefined;

  for (const packageRoot of inferCodexPackageRoots(command, env)) {
    const nativeCommand = nativeCodexCandidates(packageRoot, target).find(available);
    if (nativeCommand) return { command: nativeCommand, packageRoot };
  }
  return undefined;
}

function managedPackageMarker(
  env: NodeJS.ProcessEnv,
  command: string,
  packageRoot: string,
): string {
  const userAgent = env.npm_config_user_agent ?? "";
  const execPath = env.npm_execpath ?? "";
  if (/\bbun\//.test(userAgent) || execPath.toLowerCase().includes("bun")) {
    return CODEX_MANAGED_BY_BUN;
  }
  if (/\bpnpm\//.test(userAgent)) {
    return CODEX_MANAGED_BY_PNPM;
  }
  if (command.toLowerCase().includes(".bun\\install\\global")) {
    return CODEX_MANAGED_BY_BUN;
  }
  if (packageRoot.toLowerCase().includes("\\.pnpm\\")) {
    return CODEX_MANAGED_BY_PNPM;
  }
  return CODEX_MANAGED_BY_NPM;
}

function withManagedCodexEnvironment(
  env: NodeJS.ProcessEnv,
  packageRoot: string,
  command: string,
): NodeJS.ProcessEnv {
  const environment = { ...env };
  for (const key of Object.keys(environment)) {
    if (CODEX_MANAGED_ENV_NAMES.some((name) => key.toUpperCase() === name)) {
      delete environment[key];
    }
  }
  environment[CODEX_MANAGED_PACKAGE_ROOT] = packageRoot;
  environment[managedPackageMarker(env, command, packageRoot)] = "1";
  return environment;
}

export const resolveCodexAppServerCommand = Effect.fn("resolveCodexAppServerCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandAvailabilityOptions & { readonly env: NodeJS.ProcessEnv },
): Effect.fn.Return<ResolvedCodexAppServerCommand> {
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") {
    const hostEnvironment = yield* HostProcessEnvironment;
    const effectiveEnvironment = options.extendEnv
      ? { ...hostEnvironment, ...options.env }
      : options.env;
    const resolveExecutable = yield* SpawnExecutableResolution;
    const resolvedCommand = resolveExecutable(command, platform, effectiveEnvironment) ?? command;
    const architecture = yield* HostProcessArchitecture;
    const available = yield* CodexNativeExecutableAvailability;
    const native = resolveNativeWindowsCodex(
      resolvedCommand,
      architecture,
      effectiveEnvironment,
      available,
    );

    if (native) {
      return {
        command: native.command,
        args: [...args],
        shell: false,
        environment: withManagedCodexEnvironment(options.env, native.packageRoot, resolvedCommand),
      };
    }
  }

  const resolved = yield* resolveSpawnCommand(command, args, options);
  return { ...resolved, environment: options.env };
});
