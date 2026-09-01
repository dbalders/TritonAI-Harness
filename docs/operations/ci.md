# CI quality gates

- `.github/workflows/ci.yml` runs `vp check` (lint + typecheck), `vpr typecheck`, and `vp run test` on pull requests and pushes to `main`.
- `.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`) desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release.
- macOS release builds require the configured Apple signing/notarization inputs. Windows releases use Azure Trusted Signing when all seven inputs are configured; when none are configured, repository variable `TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE=1` authorizes the explicit unsigned path. Partial signing configuration fails closed.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.
