# Scripts

- `bun run dev` — Starts contracts, server, and web in `turbo watch` mode.
- `bun run dev:server` — Starts just the WebSocket server (uses Bun TypeScript execution).
- `bun run dev:web` — Starts just the Vite dev server for the web app.
- Dev commands default `T3CODE_STATE_DIR` to `~/.t3/dev` to keep dev state isolated from desktop/prod state.
- Override server CLI-equivalent flags from root dev commands with `--`, for example:
  `bun run dev -- --base-dir ~/.t3-2`
- `bun run start` — Runs the production server (serves built web app as static files).
- `bun run build` — Builds contracts, web app, and server through Turbo.
- `bun run typecheck` — Strict TypeScript checks for all packages.
- `bun run test` — Runs workspace tests.
- `bun run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>` — Builds a desktop artifact for a specific platform/target/arch.
- `bun run dist:desktop:dmg` — Builds a shareable macOS `.dmg` into `./release`.
- `bun run dist:desktop:dmg:x64` — Builds an Intel macOS `.dmg`.
- `bun run dist:desktop:linux` — Builds a Linux AppImage into `./release`.
- `bun run dist:desktop:win` — Builds a Windows NSIS installer into `./release`.
- `bun run dist:desktop:plugins:finalize -- --platform <mac|win> --arch <arch> --artifact <path> --output-dir release` — Binds a staged managed-plugin composition to final signed artifact bytes.

## Managed plugin release proofs

When `TRITONAI_PLUGIN_COMPOSITION_SOURCE` selects a production composition, the artifact build writes
an internal proof input but does not hash the distributable yet. Complete every operation that can
mutate the DMG or EXE, including external signing, notarization, and stapling, before finalizing:

```sh
bun run dist:desktop:plugins:finalize -- \
  --platform mac --arch arm64 \
  --artifact release/TritonAI-Harness-<version>-arm64.dmg \
  --output-dir release

bun run dist:desktop:plugins:finalize -- \
  --platform win --arch x64 \
  --artifact release/TritonAI-Harness-<version>-x64.exe \
  --output-dir release
```

The two commands publish distinct `tritonai-plugin-composition-mac-arm64.json` and
`tritonai-plugin-composition-win-x64.json` assets on the same release. The GitHub Windows workflow
runs its finalizer after electron-builder and Azure Trusted Signing return. The controlled local
macOS path must run its finalizer after any final DMG notarization or stapling step. Never mutate an
artifact after its proof is emitted; Installer verification rejects stale bytes.

## Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/macos-icon-1024.png` as the production app icon source.
- Desktop production windows load the bundled UI from `t3code://app/index.html` (not a `127.0.0.1` document URL).
- Desktop packaging includes `apps/server/dist` (the `t3` backend) and starts it on loopback with an auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first launch.
- To keep staging files for debugging package contents, run: `bun run dist:desktop:dmg -- --keep-stage`
- To require code-signing/notarization, add `--signed`. Windows signed builds fail before
  packaging unless every Azure Trusted Signing input is present, set Electron Builder's
  `forceCodeSigning`, and verify each output EXE with Authenticode before returning success.
- Signed macOS builds also require `T3CODE_APPLE_TEAM_ID` and
  `T3CODE_MACOS_PROVISIONING_PROFILE`. The passkey RP domain is derived from
  `T3CODE_CLERK_PUBLISHABLE_KEY` unless `T3CODE_CLERK_PASSKEY_RP_DOMAINS` overrides it.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Running multiple dev instances

Set `T3CODE_DEV_INSTANCE` to any value to deterministically shift all dev ports together.

- Default ports: server `3773`, web `5733`
- Shifted ports: `base + offset` (offset is hashed from `T3CODE_DEV_INSTANCE`)
- Example: `T3CODE_DEV_INSTANCE=branch-a bun run dev:desktop`

If you want full control instead of hashing, set `T3CODE_PORT_OFFSET` to a numeric offset.
