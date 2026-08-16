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

Release builds download Cua Driver `0.19.3`, verify the platform-specific SHA-256 checksum before extraction, and stage only the executable plus its license outside ASAR. Windows ZIP assets use the pinned JavaScript extractor from the scripts workspace; macOS and Linux tarballs use the host `tar`. The driver npm package, release asset version, and reviewed checksums must be upgraded together.

The desktop process owns opt-in state, permission onboarding, and driver lifetime. Computer use defaults off in TritonAI's desktop settings. Enabling it from General settings requests macOS Accessibility and Screen Recording access; ordinary startup only reads their current state and never prompts. The driver starts on launch only when the opt-in and required grants are present, uses standard permission mode, disables driver telemetry and update checks, and stops when the application scope closes. Changing the opt-in relaunches the desktop app once the renderer receives the saved state so the local backend is rebuilt with or without the private MCP contract.
