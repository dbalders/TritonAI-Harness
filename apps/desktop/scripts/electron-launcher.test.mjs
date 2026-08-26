import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import {
  APP_BUNDLE_ID,
  APP_DISPLAY_NAME,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveMacLauncherIconPaths,
  resolveMacLauncherPaths,
} from "./electron-launcher.mjs";

function executeLauncher({ capturedEnvironment, runtimeEnvironment }) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tritonai-launcher-test-"));
  const electronBinaryPath = NodePath.join(tempDir, "electron-stub");

  try {
    NodeFS.writeFileSync(
      electronBinaryPath,
      '#!/bin/sh\nprintf "TRITONAI_HOME=%s\\n" "${TRITONAI_HOME:-}"\nprintf "T3CODE_HOME=%s\\n" "${T3CODE_HOME:-}"\n',
    );
    NodeFS.chmodSync(electronBinaryPath, 0o755);

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: capturedEnvironment,
    });
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-c", script], {
      encoding: "utf8",
      env: runtimeEnvironment,
    });

    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("electron development launcher", () => {
  it("keeps the downstream desktop identity", () => {
    assert.equal(APP_DISPLAY_NAME, "TritonAI Harness");
    assert.match(APP_BUNDLE_ID, /^edu\.ucsd\.tritonai\.harness(?:\.dev\.[a-z0-9]+)?$/u);
  });

  it("uses captured values only as fallbacks for a live runner environment", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
        T3CODE_PORT: "16566",
        TRITONAI_HOME: "/tmp/tritonai",
        T3CODE_HOME: "/tmp/t3",
      },
    });

    assert.include(
      script,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.notInclude(script, "\nexport VITE_DEV_SERVER_URL=");
    assert.include(
      script,
      "if [ -z \"${TRITONAI_HOME:-}\" ]; then export TRITONAI_HOME='/tmp/tritonai'; fi",
    );
    assert.notInclude(script, "export T3CODE_HOME=");
    assert.include(script, "unset T3CODE_HOME");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --t3code-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("normalizes a captured legacy home into TRITONAI_HOME", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {
        T3CODE_HOME: "/tmp/legacy-home",
      },
    });

    assert.include(
      script,
      'if [ -z "${TRITONAI_HOME:-}" ] && [ -n "${T3CODE_HOME:-}" ]; then export TRITONAI_HOME="$T3CODE_HOME"; fi',
    );
    assert.include(
      script,
      "if [ -z \"${TRITONAI_HOME:-}\" ]; then export TRITONAI_HOME='/tmp/legacy-home'; fi",
    );
    assert.notInclude(script, "export T3CODE_HOME=");
    assert.include(script, "unset T3CODE_HOME");
  });

  it("keeps captured TRITONAI_HOME ahead of a live legacy input", () => {
    const output = executeLauncher({
      capturedEnvironment: {
        TRITONAI_HOME: "/tmp/captured-tritonai",
        T3CODE_HOME: "/tmp/captured-legacy",
      },
      runtimeEnvironment: {
        T3CODE_HOME: "/tmp/runtime-legacy",
      },
    });

    assert.equal(output, "TRITONAI_HOME=/tmp/captured-tritonai\nT3CODE_HOME=\n");
  });

  it("promotes a live legacy input when no home was captured", () => {
    const output = executeLauncher({
      capturedEnvironment: {},
      runtimeEnvironment: {
        T3CODE_HOME: "/tmp/runtime-legacy",
      },
    });

    assert.equal(output, "TRITONAI_HOME=/tmp/runtime-legacy\nT3CODE_HOME=\n");
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app",
      "T3 Code (Dev)",
    );

    assert.equal(paths.launcherExecutableName, "T3 Code (Dev) Launcher");
    assert.equal(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/T3 Code (Dev) Launcher",
    );
    assert.equal(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {},
    });
    assert.include(
      script,
      "exec '/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app/Contents/MacOS/Electron'",
    );
    assert.notInclude(script, "node_modules/electron");
  });

  it("derives launcher icons from canonical development and production assets", () => {
    const development = resolveMacLauncherIconPaths("/runtime", true);
    const production = resolveMacLauncherIconPaths("/runtime", false);

    assert.match(development.sourceIconPath, /assets\/dev\/blueprint-macos-1024\.png$/);
    assert.equal(development.generatedIconPath, "/runtime/icon-dev.icns");
    assert.match(production.sourceIconPath, /assets\/prod\/black-macos-1024\.png$/);
    assert.equal(production.generatedIconPath, "/runtime/icon-prod.icns");
  });
});
