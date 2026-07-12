import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import { makeDevelopmentLauncherScript } from "./electron-launcher.mjs";

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
});
