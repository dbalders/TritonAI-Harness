# TritonAI Harness Release Checklist

This document covers the controlled TritonAI Harness release workflow in
`.github/workflows/release.yml`.

TritonAI Harness releases first. TritonAI Installer is built and published afterward against the
exact verified Harness assets.

## Distribution boundary

TritonAI Harness is distributed through its GitHub release assets and TritonAI Installer. The
workflow does not publish, verify, or depend on the public npm package named `t3`; that package is
the upstream T3 Code distribution and is not the UCSD-managed Harness install path.

The upstream server self-update contracts remain in source for compatibility, but non-desktop
servers do not advertise automatic replacement and clients do not render or copy public-package
update commands. See [Server Update Architecture](../architecture/server-updates.md).

## Workflow contract

The workflow runs for:

- a pushed stable tag matching `v*.*.*`, excluding upstream nightly tags;
- a manual dispatch with an explicit version.

It requires a controlled GitHub release for the exact tag to exist as an unpublished draft. The
draft remains private until all automated Harness checks, Windows packaging, selected trust-mode
verification, composition, and asset validation succeed.

The workflow:

1. resolves and validates the release version and exact tagged ref;
2. verifies the controlled release is still a draft;
3. runs `vp check`, typecheck, and the full test suite;
4. builds a Linux `node-pty` binary for the packaged Windows WSL backend;
5. validates the pinned Installer composition commit and managed-plugin ref/commit;
6. asks the pinned Installer commit to prepare its reviewed production managed-plugin composition;
7. aligns package versions in the isolated build checkout;
8. builds the Windows x64 NSIS Harness artifact;
9. selects signed Windows mode when all Azure inputs exist; with zero Azure inputs, selects unsigned
   mode only when `TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE=1`; partial Azure configuration fails;
10. finalizes the managed-plugin composition proof;
11. uploads the required Windows installer, blockmap, updater metadata, and composition proof;
12. verifies the release is still a draft and only then publishes it;
13. updates version metadata on `main` and announces the release after publication succeeds.

The standard public GitHub runner workflow does not build macOS Harness assets. Verified macOS
assets are produced through the controlled local signed/notarized release path and attached to the
draft before it is published.

## Draft-first publication sequence

1. Freeze the intended Harness commit and artifact contract.
2. Produce, sign, notarize, and validate required local macOS assets.
3. Create the exact tag and an unpublished GitHub draft for it.
4. Attach the verified local assets to the draft.
5. Push the tag or dispatch the workflow for that version.
6. Wait for preflight, Windows build, selected trust-mode boot proof, managed-plugin proof, and required-asset checks.
7. Let the workflow validate Authenticode publisher identity and timestamps for signed releases, or
   validate unsigned status for explicitly unsigned releases, then attach Windows assets and publish
   the draft.
8. Verify the published release state and downloaded asset identities.
9. Only then build and publish TritonAI Installer against those exact Harness assets.

Do not publish the draft manually while the workflow is running. Both preflight and the release job
fail closed if the controlled release is no longer a draft.

## Required downstream release pins

Repository variables:

- `TRITONAI_INSTALLER_COMPOSITION_COMMIT`: exact 40-character Installer commit that produces the
  managed-plugin composition.
- `TRITONAI_PLUGINS_REF`: explicit branch or tag ref in `dbalders/TritonAI-Plugins`.
- `TRITONAI_PLUGINS_COMMIT`: exact commit resolved by that ref.
- `TRITONAI_PLUGIN_CONFIGURATION_JSON`: bounded JSON object keyed by every package ID in the selected
  composition. Each plugin owns and validates its opaque configuration object.

The workflow verifies the plugin checkout resolves to the pinned commit and detaches it before
building. A preparation job uploads that exact composition before any provider code executes. A
second, credential-free runner validates the immutable composition and emits a receipt binding its
source, contents, and exact configuration. The Windows build consumes those two artifacts on a
third fresh runner, verifies the receipt, and packages the composition without executing provider
code. The final proof manifest is a required release asset.

## Windows signing

Signed Windows artifacts require all of:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

When all seven values exist, the workflow signs the artifact, verifies every EXE with Authenticode,
checks its timestamp and publisher identity, then installs and boots the exact package. When none
exist, repository variable `TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE=1` authorizes an explicitly
unsigned artifact, and the workflow verifies that both the installer and installed executable are
actually unsigned before boot testing. A partial signing configuration fails closed; without the
explicit opt-in, zero signing inputs also fail closed. The workflow never silently falls back from
a broken signed setup to unsigned mode. Unsigned downloads may trigger Microsoft Defender SmartScreen.

## Required release assets

The release job refuses publication unless every required Windows pattern matches:

- `*.exe`
- `*.blockmap`
- updater `*.yml`
- `tritonai-plugin-composition-*.json`

Local macOS assets and checksums must already match the frozen artifact contract. A workflow success
proves the automated Windows lane and publication transition; it does not by itself prove
installation or runtime behavior on either platform.

## Release validation

Before declaring the Harness release ready for Installer consumption:

1. Confirm the published tag resolves to the frozen Harness commit.
2. Download every expected asset and record its SHA-256.
3. Confirm Windows Authenticode identity and macOS codesign, notarization, and Gatekeeper results.
4. Confirm the managed-plugin proof names the expected Installer and plugin commits.
5. Run packaged-app regression with an isolated profile, including first launch, provider startup,
   preview tools, managed plugins, and update presentation.
6. Confirm version-skew UI never offers a remote public-package update action.
7. Record remaining native/mobile or platform-specific gates separately.

Only after these checks should the Installer vendor and publish the Harness assets.

## Troubleshooting

- **Draft gate fails:** confirm the exact tag has an existing unpublished release and that nobody
  published it early.
- **Plugin pin check fails:** verify all three downstream pin variables are exact and that the ref
  resolves to the stated plugin commit.
- **Windows signing fails:** verify every Azure value and the expected publisher Common Name.
- **WSL backend artifact is missing:** rerun the Linux `node-pty` prerequisite and do not bypass the
  Windows build dependency.
- **Required asset pattern is missing:** inspect the packaging output and composition-proof step;
  do not publish a partial draft manually.
- **Version metadata finalization fails:** the release may still be valid, but `main` has not yet
  recorded the released version. Reconcile that state by PR before the next release.
