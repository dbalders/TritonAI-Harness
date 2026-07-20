# CI quality gates

- `.github/workflows/ci.yml` runs `bun run lint`, `bun run typecheck`, and `bun run test` on pull requests and pushes to `main`.
- `.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`) desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release.
- The stable release workflow requires signing credentials. macOS passkey builds additionally require `APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows requires every Azure Trusted Signing input and rejects unsigned or publisher-mismatched EXE artifacts before upload.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.
