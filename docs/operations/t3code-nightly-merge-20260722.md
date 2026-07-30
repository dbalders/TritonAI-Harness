# T3 Code nightly merge decisions — 2026-07-22

## Frozen inputs

- Downstream base: `origin/main` at `b55406d50ef6f9c1f82f813114469abc055fbc75`
- Upstream nightly: `v0.0.29-nightly.20260722.875` at `32c6012dabdbd0eb178b25ea4225d889ec8f6475`
- Merge base: `fda6486233e0b2f07ecfea166e1a94533cb923c4`
- Integration branch: `merge/t3code-nightly-20260722`
- Initial divergence: 90 downstream commits and 157 nightly commits
- Git-reported conflicts: 87

## Resolution policy

Nightly wins by default. Downstream behavior is retained only where it implements an explicit
TritonAI product contract: UCSD/TritonAI branding and assets, managed provider/model policy,
dynamic preview tools, runtime access modes, encrypted secrets, the Installer-based update path,
release governance, `TRITONAI_HOME`, and migration compatibility.

## Conflict ledger

| Conflicted path                                                    | Decision                                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `.env.example`                                                     | Union: nightly hosted-app configuration plus TritonAI managed-plugin composition variables.                                   |
| `.github/workflows/mobile-eas-preview.yml`                         | Downstream: keep deleted; TritonAI does not restore the legacy T3 Connect preview workflow.                                   |
| `.github/workflows/release.yml`                                    | Downstream: retain TritonAI release governance and artifact flow; do not add upstream hosted deployment assumptions.          |
| `AGENTS.md`                                                        | Downstream: retain TritonAI repository and release governance.                                                                |
| `apps/desktop/package.json`                                        | Union: take nightly dependencies and scripts while retaining TritonAI release version 0.3.0.                                  |
| `apps/desktop/scripts/electron-launcher.mjs`                       | Union: nightly launcher version and executable behavior with TritonAI app identity, bundle IDs, and microphone permission.    |
| `apps/desktop/scripts/electron-launcher.test.mjs`                  | Union: nightly repair/native executable coverage plus TritonAI identity and TRITONAI_HOME coverage.                           |
| `apps/desktop/src/app/DesktopEnvironment.ts`                       | Union: nightly explicit base-directory behavior with TRITONAI_HOME and TritonAI userdata names.                               |
| `apps/desktop/src/window/DesktopWindow.test.ts`                    | Union: nightly window-bounds/fullscreen coverage plus TritonAI clipboard and microphone permission tests.                     |
| `apps/marketing/src/layouts/Layout.astro`                          | Nightly layout/content features, rebranded with TritonAI titles and product copy.                                             |
| `apps/marketing/src/pages/index.astro`                             | Nightly layout/content features, rebranded with TritonAI titles and product copy.                                             |
| `apps/mobile/app.config.ts`                                        | Nightly structure, rebranded: retain the new variant/icon architecture with TritonAI names, permissions, and assets.          |
| `apps/mobile/assets/android-icon-background.png`                   | Downstream asset: retain TritonAI mobile artwork even though the nightly asset pipeline moved to centralized assets.          |
| `apps/mobile/assets/android-icon-foreground.png`                   | Downstream asset: retain TritonAI mobile artwork even though the nightly asset pipeline moved to centralized assets.          |
| `apps/mobile/assets/android-icon-monochrome.png`                   | Downstream asset: retain TritonAI mobile artwork even though the nightly asset pipeline moved to centralized assets.          |
| `apps/mobile/assets/favicon.png`                                   | Downstream asset: retain TritonAI mobile artwork even though the nightly asset pipeline moved to centralized assets.          |
| `apps/mobile/assets/icon.png`                                      | Downstream asset: retain TritonAI mobile artwork even though the nightly asset pipeline moved to centralized assets.          |
| `apps/mobile/assets/splash-icon.png`                               | Downstream asset: retain TritonAI mobile artwork even though the nightly asset pipeline moved to centralized assets.          |
| `apps/mobile/src/app/settings/index.tsx`                           | Nightly deletion: settings moved to the new route architecture; ported TritonAI copy into SettingsRouteScreen.                |
| `apps/mobile/src/components/BrandMark.tsx`                         | Nightly component structure, rebranded with stage-aware TritonAI assets and wordmark.                                         |
| `apps/mobile/src/connection/platform.ts`                           | Nightly mobile architecture and behavior, with conflicting T3 naming replaced by TritonAI branding and cloud copy.            |
| `apps/mobile/src/features/cloud/CloudWaitlistEnrollment.tsx`       | Nightly mobile architecture and behavior, with conflicting T3 naming replaced by TritonAI branding and cloud copy.            |
| `apps/mobile/src/features/connection/CloudEnvironmentRows.tsx`     | Nightly mobile architecture and behavior, with conflicting T3 naming replaced by TritonAI branding and cloud copy.            |
| `apps/mobile/src/features/connection/ConnectionEnvironmentRow.tsx` | Nightly mobile architecture and behavior, with conflicting T3 naming replaced by TritonAI branding and cloud copy.            |
| `apps/mobile/src/features/home/HomeHeader.tsx`                     | Nightly mobile architecture and behavior, with conflicting T3 naming replaced by TritonAI branding and cloud copy.            |
| `apps/mobile/src/widgets/AgentActivity.tsx`                        | Nightly mobile architecture and behavior, with conflicting T3 naming replaced by TritonAI branding and cloud copy.            |
| `apps/server/package.json`                                         | Union: take nightly dependencies and scripts while retaining TritonAI release version 0.3.0.                                  |
| `apps/server/src/bin.test.ts`                                      | Union: take nightly server behavior while preserving the applicable TritonAI home, migration, or settings contract.           |
| `apps/server/src/cli/config.ts`                                    | Union: take nightly server behavior while preserving the applicable TritonAI home, migration, or settings contract.           |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` | Union: take nightly server behavior while preserving the applicable TritonAI home, migration, or settings contract.           |
| `apps/server/src/persistence/Migrations.ts`                        | Union: preserve downstream migration 033 and renumber nightly projection settlement migration to 034.                         |
| `apps/server/src/provider/Layers/CodexAdapter.ts`                  | Union: nightly launch/plugin/model protocol with TritonAI managed-model, dynamic-tool, image-context, and provider policy.    |
| `apps/server/src/provider/Layers/CodexProvider.test.ts`            | Union: nightly launch/plugin/model protocol with TritonAI managed-model, dynamic-tool, image-context, and provider policy.    |
| `apps/server/src/provider/Layers/CodexProvider.ts`                 | Union: nightly launch/plugin/model protocol with TritonAI managed-model, dynamic-tool, image-context, and provider policy.    |
| `apps/server/src/provider/Layers/CodexSessionRuntime.test.ts`      | Union: nightly launch/plugin/model protocol with TritonAI managed-model, dynamic-tool, image-context, and provider policy.    |
| `apps/server/src/provider/Layers/CodexSessionRuntime.ts`           | Union: nightly launch/plugin/model protocol with TritonAI managed-model, dynamic-tool, image-context, and provider policy.    |
| `apps/server/src/provider/Layers/ProviderRegistry.test.ts`         | Union: nightly launch/plugin/model protocol with TritonAI managed-model, dynamic-tool, image-context, and provider policy.    |
| `apps/server/src/serverSettings.test.ts`                           | Union: take nightly server behavior while preserving the applicable TritonAI home, migration, or settings contract.           |
| `apps/server/src/textGeneration/CodexTextGeneration.test.ts`       | Union: nightly launch/plugin/model protocol with TritonAI managed-model, dynamic-tool, image-context, and provider policy.    |
| `apps/server/src/textGeneration/CodexTextGeneration.ts`            | Union: nightly launch/plugin/model protocol with TritonAI managed-model, dynamic-tool, image-context, and provider policy.    |
| `apps/server/vite.config.ts`                                       | Union: nightly CLI build channel plus TritonAI managed-plugin composition defines.                                            |
| `apps/web/package.json`                                            | Union: take nightly dependencies and scripts while retaining TritonAI release version 0.3.0.                                  |
| `apps/web/public/apple-touch-icon.png`                             | Downstream binary asset: retain TritonAI web favicons and touch icon.                                                         |
| `apps/web/public/favicon-16x16.png`                                | Downstream binary asset: retain TritonAI web favicons and touch icon.                                                         |
| `apps/web/public/favicon-32x32.png`                                | Downstream binary asset: retain TritonAI web favicons and touch icon.                                                         |
| `apps/web/public/favicon.ico`                                      | Downstream binary asset: retain TritonAI web favicons and touch icon.                                                         |
| `apps/web/src/branding.logic.ts`                                   | Union: hide Latest, Alpha, and Dev suffixes while preserving TritonAI display naming.                                         |
| `apps/web/src/components/ChatView.tsx`                             | Nightly: take draft-hero and docked composer architecture; preserve TritonAI project selection and runtime controls.          |
| `apps/web/src/components/Sidebar.tsx`                              | Nightly: take pinned projects and new sidebar behavior; preserve standalone Chats routing and downstream settings behavior.   |
| `apps/web/src/components/chat/ChatComposer.tsx`                    | Union: nightly voice input and composer surface with TritonAI project-selection and runtime-access constraints.               |
| `apps/web/src/components/chat/ThreadErrorBanner.tsx`               | Nightly: take accessibility focus support and corrected Tailwind expression.                                                  |
| `apps/web/src/components/settings/ConnectionsSettings.tsx`         | Union: nightly connection discovery UI with downstream managed-tunnel and agent-activity controls; use TritonAI Connect copy. |
| `apps/web/src/components/sidebar/SidebarUpdatePill.tsx`            | Downstream: retain full TritonAI Installer update flow instead of upstream desktop self-update behavior.                      |
| `apps/web/src/connection/platform.ts`                              | Nightly flow, rebranded with TritonAI Harness Cloud authentication messages.                                                  |
| `apps/web/src/hooks/useHandleNewThread.ts`                         | Nightly: take NewThreadOptions and draft-prompt behavior; preserve downstream project grouping and route behavior.            |
| `apps/web/src/index.css`                                           | Union: nightly graphite sidebar-v2 surface plus UCSD light and dark theme tokens.                                             |
| `assets/dev/app-icon.icon/icon.json`                               | Downstream asset metadata: preserve the TritonAI icon composition while using the nightly centralized path.                   |
| `assets/dev/blueprint-ios-1024.png`                                | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/dev/blueprint-macos-1024.png`                              | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/dev/blueprint-universal-1024.png`                          | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/dev/blueprint-web-apple-touch-180.png`                     | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/dev/blueprint-web-favicon-16x16.png`                       | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/dev/blueprint-web-favicon-32x32.png`                       | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/dev/blueprint-web-favicon.ico`                             | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/dev/blueprint-windows.ico`                                 | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/prod/app-icon.icon/Assets/text.svg`                        | Nightly deletion: remove obsolete upstream text layer from the TritonAI icon project.                                         |
| `assets/prod/app-icon.icon/Assets/tritonai-dev-rainbow.png`        | Downstream asset: preserve TritonAI icon source at the nightly asset-project location.                                        |
| `assets/prod/app-icon.icon/icon.json`                              | Downstream asset metadata: preserve the TritonAI icon composition while using the nightly centralized path.                   |
| `assets/prod/black-ios-1024.png`                                   | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/prod/black-macos-1024.png`                                 | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/prod/black-universal-1024.png`                             | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/prod/t3-black-web-apple-touch-180.png`                     | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/prod/t3-black-web-favicon-16x16.png`                       | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/prod/t3-black-web-favicon-32x32.png`                       | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/prod/t3-black-web-favicon.ico`                             | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `assets/prod/t3-black-windows.ico`                                 | Nightly deletion: do not retain obsolete upstream T3 artwork alongside the centralized TritonAI assets.                       |
| `docs/operations/effect-fn-checklist.md`                           | Nightly: take portable relative links.                                                                                        |
| `docs/operations/observability.md`                                 | Nightly trace workflow, adapted to TRITONAI_HOME.                                                                             |
| `docs/reference/scripts.md`                                        | Nightly vp command reference plus downstream managed-plugin release proofs and signing gates.                                 |
| `packages/contracts/package.json`                                  | Union: take nightly dependencies and scripts while retaining TritonAI release version 0.3.0.                                  |
| `packages/contracts/src/model.ts`                                  | Union: nightly preferred Codex models and aliases with TritonAI default model policy.                                         |
| `packages/contracts/src/settings.ts`                               | Union: nightly sidebar auto-settle and voice settings with launchArgs, managed models, and TritonAI metadata.                 |
| `packages/shared/src/model.test.ts`                                | Union: nightly model aliases and selection coverage with downstream option and prompt-effort tests.                           |
| `scripts/build-desktop-artifact.test.ts`                           | Union: nightly package-manager/native dependency coverage plus TritonAI plugin packaging and Azure signing coverage.          |
| `scripts/dev-runner.test.ts`                                       | Union: nightly browser-default tests with TRITONAI_HOME isolation coverage.                                                   |
| `scripts/dev-runner.ts`                                            | Union: nightly browser and runner behavior with TRITONAI_HOME as the canonical home contract.                                 |
| `scripts/lib/brand-assets.ts`                                      | Union: nightly centralized asset schema with TritonAI assets for development, nightly, and production.                        |

## Validation

- `vp check --fix`: passed with zero errors; seven pre-existing nightly React nested-component warnings remain.
- `vp run typecheck`: passed across all 15 workspaces.
- `vp run lint:mobile`: native-source discovery passed; SwiftLint, ktlint, and detekt were unavailable locally and were skipped.
- `vp run build`: passed for marketing, web, server, and desktop.
- `vp install --frozen-lockfile`: passed, including both patched dependencies.
- `vp test`: the final full run completed 5,690 passing and 7 skipped tests with one local HTTP `ECONNRESET`; that exact redirect test passed immediately in isolation. Two earlier full runs each completed 5,683 passing and 7 skipped tests with one timing-sensitive failure (HTTP reset, then Grok completion-drain timeout); both exact tests also passed in isolation.
- Focused hardening suites: 319 tests passed across the server, desktop, mobile, relay, scripts, and sharing paths touched during review.

## Review hardening

The merge received two complete eight-part structured reviews plus a final targeted review of the accepted blocker fixes. Accepted findings were fixed for preview clipboard permissions, Android terminal compilation and cursor rendering, mobile database and route safety, native share memory limits, stale pending-task saves, SQLite external-database mutation, bounded WebSocket subscriptions, AppImage environment handling, sidebar capability compatibility, iOS toolbar actions, dependency callback freshness, relay terminal aggregation, and integer settings validation. The final targeted autoreview reported no accepted or actionable findings.

The full merge exceeded the review helper's eight-pass limit and included binary and secret-shaped fixture paths. Review-only synthetic commits therefore retained the complete safe source surface while excluding lockfile/binary noise and one fixture file rejected by the helper. The real merge tree and tests remained authoritative.

## Remaining release follow-ups

- Native sharing needs a per-handoff identifier from the native layer to distinguish an intentional repeated share from crash replay. The content hash cannot provide both guarantees without a native contract change.
- The iOS Mail-style search toolbar needs a native focus command before Cmd-F can target it. This requires extending the patched toolbar bridge.
- iOS terminal hardware arrows still need a state-aware Ghostty key bridge for DECCKM application cursor mode.
- Icon Composer 2.x was unavailable. The new platform-specific TritonAI icon paths are populated from the existing approved TritonAI rasters, but a proper `icons:check`/Icon Composer export remains a release-artifact gate.
- SwiftLint, ktlint, and detekt must run in CI or on a machine with the mobile native toolchain before release approval.
