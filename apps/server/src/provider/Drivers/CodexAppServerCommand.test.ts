import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  CodexNativeExecutableAvailability,
  resolveCodexAppServerCommand,
} from "./CodexAppServerCommand.ts";

const windowsEnvironment = {
  PATH: "C:\\Users\\tester\\.agents\\ucsd\\runtime\\codex",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  CODEX_HOME: "C:\\Users\\tester\\.codex",
};

function windowsRuntime(
  command: string,
  architecture: NodeJS.Architecture,
  available: (path: string) => boolean,
) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(HostProcessArchitecture, architecture),
      Effect.provideService(HostProcessEnvironment, windowsEnvironment),
      Effect.provideService(SpawnExecutableResolution, () => command),
      Effect.provideService(CodexNativeExecutableAvailability, available),
    );
}

describe("resolveCodexAppServerCommand", () => {
  effectIt("launches the Installer's x64 native Codex payload without a shell", () =>
    Effect.gen(function* () {
      const shim =
        "C:\\Users\\tester\\.agents\\ucsd\\runtime\\codex\\openai-codex-0.144.3\\codex.cmd";
      const native =
        "C:\\Users\\tester\\.agents\\ucsd\\runtime\\codex\\openai-codex-0.144.3\\lib\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";

      const resolved = yield* resolveCodexAppServerCommand(shim, ["app-server"], {
        env: {
          CODEX_HOME: "C:\\Users\\tester\\.codex",
          codex_managed_by_bun: "1",
        },
        extendEnv: true,
      }).pipe(windowsRuntime(shim, "x64", (candidate) => candidate === native));

      expect(resolved).toEqual({
        command: native,
        args: ["app-server"],
        shell: false,
        environment: {
          CODEX_HOME: "C:\\Users\\tester\\.codex",
          CODEX_MANAGED_PACKAGE_ROOT:
            "C:\\Users\\tester\\.agents\\ucsd\\runtime\\codex\\openai-codex-0.144.3\\lib\\node_modules\\@openai\\codex",
          CODEX_MANAGED_BY_NPM: "1",
        },
      });
    }),
  );

  effectIt("selects the arm64 native package and preserves a pnpm marker", () =>
    Effect.gen(function* () {
      const shim = "C:\\Tools\\codex.cmd";
      const native =
        "C:\\Tools\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe";
      const resolved = yield* resolveCodexAppServerCommand(
        shim,
        ["app-server", "--enable", "foo"],
        {
          env: { npm_config_user_agent: "pnpm/10.0.0 node/v22.22.2 win32 arm64" },
        },
      ).pipe(windowsRuntime(shim, "arm64", (candidate) => candidate === native));

      expect(resolved.command).toBe(native);
      expect(resolved.args).toEqual(["app-server", "--enable", "foo"]);
      expect(resolved.shell).toBe(false);
      expect(resolved.environment).toEqual({
        npm_config_user_agent: "pnpm/10.0.0 node/v22.22.2 win32 arm64",
        CODEX_MANAGED_PACKAGE_ROOT: "C:\\Tools\\node_modules\\@openai\\codex",
        CODEX_MANAGED_BY_PNPM: "1",
      });
    }),
  );

  effectIt("resolves the native payload behind a project-local npm shim", () =>
    Effect.gen(function* () {
      const shim = "C:\\project\\node_modules\\.bin\\codex.cmd";
      const native =
        "C:\\project\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";

      const resolved = yield* resolveCodexAppServerCommand(shim, ["app-server"], {
        env: windowsEnvironment,
      }).pipe(windowsRuntime(shim, "x64", (candidate) => candidate === native));

      expect(resolved.command).toBe(native);
      expect(resolved.shell).toBe(false);
      expect(resolved.environment.CODEX_MANAGED_PACKAGE_ROOT).toBe(
        "C:\\project\\node_modules\\@openai\\codex",
      );
    }),
  );

  effectIt("falls back to the Windows command shim when the native payload is missing", () =>
    Effect.gen(function* () {
      const shim = "C:\\Program Files\\Codex\\codex.cmd";
      const resolved = yield* resolveCodexAppServerCommand(shim, ["app-server", "value & calc"], {
        env: windowsEnvironment,
      }).pipe(windowsRuntime(shim, "x64", () => false));

      expect(resolved.shell).toBe(true);
      expect(resolved.command).toContain("codex.cmd");
      expect(resolved.args).toEqual(['^"app-server^"', '^"value^ ^&^ calc^"']);
      expect(resolved.environment).toBe(windowsEnvironment);
    }),
  );

  effectIt("leaves an explicitly configured Windows executable unchanged", () =>
    Effect.gen(function* () {
      const executable = "C:\\Custom\\codex.exe";
      const resolved = yield* resolveCodexAppServerCommand(executable, ["app-server"], {
        env: windowsEnvironment,
      }).pipe(windowsRuntime(executable, "x64", () => false));

      expect(resolved).toEqual({
        command: executable,
        args: ["app-server"],
        shell: false,
        environment: windowsEnvironment,
      });
    }),
  );

  effectIt("leaves non-Windows launch behavior unchanged", () =>
    Effect.gen(function* () {
      const environment = { PATH: "/usr/local/bin:/usr/bin" };
      const resolved = yield* resolveCodexAppServerCommand("codex", ["app-server"], {
        env: environment,
      }).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

      expect(resolved).toEqual({
        command: "codex",
        args: ["app-server"],
        shell: false,
        environment,
      });
    }),
  );
});
