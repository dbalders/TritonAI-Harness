# Computer-use runtime

TritonAI Harness embeds Cua Driver in the Electron main process and passes its private stdio MCP launch contract through the local desktop bootstrap. WSL, SSH, and other remote backends never receive that contract.

## Provider decisions

Computer use is a provider-shaped feature. The initial release makes these explicit choices:

| Provider | Decision                      | Reason                                                                                                                                                      |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | Supported                     | `CodexAdapter` registers the private `cua-driver` stdio MCP server, merges its child-process environment, and supplies computer-use operating instructions. |
| Claude   | Not supported in this release | Its SDK MCP configuration and instruction contract have not been integrated or validated with the desktop-owned driver lifecycle.                           |
| Cursor   | Not supported in this release | Its ACP runtime currently receives the shared HTTP browser MCP only; Cua stdio transport and instructions are not validated.                                |
| Grok     | Not supported in this release | Its ACP runtime currently receives the shared HTTP browser MCP only; Cua stdio transport and instructions are not validated.                                |
| OpenCode | Not supported in this release | Its managed MCP configuration is not wired to the desktop-owned private driver lifecycle.                                                                   |

Do not pass the desktop contract to another adapter until that provider's transport, environment propagation, instructions, approvals, cancellation, and shutdown cleanup have dedicated tests.

## Development and packaging

Development builds may set `TRITONAI_CUA_DRIVER_PATH` to an absolute path to a compatible `cua-driver` executable. Packaged builds ignore this override and always resolve the bundled executable from Electron's resources directory.

On macOS, permission checks describe the running process. Launching the development executable from an agent or terminal can attribute access to its parent instead of the app; see the [Cua TCC launch-attribution issue](https://github.com/trycua/cua/issues/1465). If System Settings and live checks disagree, quit the development app and open its `.app` through macOS LaunchServices, preserving the isolated development home and driver path. Validate permission onboarding with the actual packaged app before release.

Release builds download Cua Driver `0.19.3`, verify the platform-specific SHA-256 checksum before extraction, and stage only the executable plus its license outside ASAR. Windows ZIP assets use the pinned JavaScript extractor from the scripts workspace; macOS and Linux tarballs use the host `tar`. The driver npm package, release asset version, and reviewed checksums must be upgraded together.

The desktop process owns opt-in state, permission onboarding, and driver lifetime. Computer use defaults off in TritonAI's desktop settings. Enabling it from General settings requests macOS Accessibility and Screen Recording access; ordinary startup only reads their current state and never prompts. The driver starts on launch only when the opt-in and required grants are present, uses standard permission mode, disables driver telemetry and update checks, and stops when the application scope closes. Changing the opt-in relaunches the desktop app once the renderer receives the saved state so the local backend is rebuilt with or without the private MCP contract.

## Permission onboarding and readiness

Explicit opt-in and permission retries call the SDK's host permission request, then request a minimal screen capture from Electron when Screen Recording is still absent. This registers the Electron host with macOS even when the SDK-only request did not produce a screen prompt. The thumbnail is discarded; it is not stored or sent to an agent. A denied capture returns the current grants and opens the Screen Recording settings page. Read-only checks and startup never request capture.

The local backend bootstrap includes `computerUseState` alongside the optional MCP launch contract. Codex receives the startup readiness snapshot in its turn instructions, including the missing grant and a setup direction when blocked. WSL and remote bootstrap paths omit both fields. The Settings panel reads live state on focus, visibility restoration, and on demand. While enabled and awaiting grants, it schedules a read one second after the previous check completes. It stops periodic checks when grants are ready, the feature is off or unavailable, or the panel is hidden or unmounted. Reads are serialized, ignored after cleanup, and suspended during opt-in changes so stale responses cannot overwrite a saved setting. Retrying an enabled but disconnected driver relaunches after grants are ready; turning it off relaunches to remove the MCP connection.

The web/desktop composer exposes `/computer-use` to explain availability across providers and environments. Explicit requests on the native primary desktop are checked through its bridge before sending; unsupported providers and WSL receive setup guidance. Other clients and connected hosts rely on the target backend status in the agent instructions rather than reading another computer's permissions. Native mobile continues to show the readable server-provided computer-use activity title. Web/desktop timelines identify cards from structured `mcp_tool_call` data with `server = cua-driver`, not from assistant text. These cards stay visible after a turn finishes and separate from generic completed tool groups. Browser availability checks specifically identify the `t3-code` MCP server so a desktop-only connection does not advertise browser tools.
