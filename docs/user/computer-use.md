# Computer use

TritonAI Harness packages [Cua Driver](https://github.com/trycua/cua) as its local computer-use runtime. A separate Codex or ChatGPT desktop installation is not required, and TritonAI does not read or modify the user's normal `~/.codex` configuration.

On macOS, grant TritonAI Harness both Accessibility and Screen Recording access when macOS asks. If System Settings opens, enable TritonAI Harness and restart the app. The driver does not start until both grants are present. Windows and Linux do not use the macOS permission flow.

When available, the Codex agent can inspect apps and windows, capture the desktop, use accessibility elements, click, type, scroll, drag, press shortcuts, and show a session-owned agent cursor. It is instructed to observe before acting, verify meaningful actions, and honor permission or approval failures.

Computer use is available only to the local desktop backend. WSL, SSH, and other remote backends intentionally do not receive the host computer-use connection.

For development builds, set `TRITONAI_CUA_DRIVER_PATH` to an absolute path to a compatible `cua-driver` executable. Release builds download version `0.19.3` from the upstream GitHub release, verify a platform-specific SHA-256 checksum, place the executable outside ASAR, and disable the driver's own telemetry and update checks. Driver upgrades must update the pinned npm package, release asset version, and reviewed checksums together.
