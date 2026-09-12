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
5. validates the pinned Installer composition-producer commit;
6. asks that Installer commit to resolve and prepare its reviewed, digest-bound production
   managed-plugin catalog;
7. aligns package versions in the isolated build checkout;
8. builds the Windows x64 NSIS Harness artifact;
9. selects signed Windows mode when all Azure inputs exist; with zero Azure inputs, selects unsigned
   mode only when `TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE=1`; partial Azure configuration fails;
10. finalizes the managed-plugin composition proof;
11. uploads the required Windows installer, blockmap, updater metadata, and composition proof;
12. verifies the release is still a draft and only then publishes it;
13. updates version metadata on `main` and announces the release after publication succeeds.

The stable release workflow keeps its controlled local macOS packaging path. The separate
`nightly.yml` workflow builds macOS and Windows on standard GitHub-hosted runners; it cannot
publish a stable release or update stable version metadata.

## Local source staging and release scope

The Installer repository's `release:local` command supports `--scope harness` for Harness-only
candidates and defaults to `--scope full` for Harness plus Installer. Harness-only preparation
still consumes the pinned Installer-owned plugin catalog and composition producer, but skips
Installer dependencies, app compilation, tests, packaging, and secure skills checkout.

On macOS that runner invokes this repository's artifact builder with `--platform mac --target zip
--arch arm64 --keep-stage --stage-only`. This prepares source and runtime dependencies plus the
managed-plugin composition input proof; it returns before Electron Builder and emits no release
artifacts. The matching local finalizer packages/signs the retained stage once, then runs
`scripts/verify-macos-desktop-package.ts` against the signed app to enforce the same update-config
and native-binary checks as ordinary artifact builds. It still verifies signed/notarized DMG and
ZIP payloads, packaged boot, and final composition proofs. A retained stage is not release proof.

`--stage-only` requires a retained Mac arm64 ZIP stage with signing and mock updates disabled in the
source-preparation command. Normal artifact builds retain their existing behavior. Use matching
Harness and Installer revisions when adopting this split.

Harness has a separate nightly workflow. Installer remains a full-release-only product. The
local release runner still defaults to full stable releases; nightly CI reuses its pinned Mac
finalizer without invoking Installer app packaging.

## Nightly identity and artwork

Nightly candidates must use `BASE-nightly.YYYYMMDD.RUN` in every releasable package before
compilation. A GitHub prerelease flag or a nightly release title alone does not select the
runtime stage. In a fresh isolated checkout, prepare them with:

```sh
node scripts/resolve-nightly-release.ts --date 20260912 --run-number 1 --sha COMMIT_SHA --prepare --github-output
```

Omit `--github-output` outside Actions. The command derives the next patch version from the
checked-out desktop package, writes it to desktop/server/web/contracts manifests, and emits
`release_channel=nightly`, `version`, and `tag`. Run preparation once per fresh checkout and
use the emitted version throughout packaging. The artifact builder rejects mixed stable and
nightly source versions so a nightly package cannot silently ship stable server/sidebar branding.

The existing Nightly runtime stage selects the starry sidebar header (with environment
identification set to its default Artwork mode), the Nightly app name, and nightly updates.
Explicit user settings that hide artwork remain respected. Nightly asset paths now select the
TritonAI starry logo, while stable and development assets keep their respective designs.
See [nightly artwork source and exports](../../assets/nightly/README.md).

Manual release dispatch also classifies nightly versions as the nightly channel, keeps them
as prereleases, and never promotes them to latest or writes their version onto stable main.
The dedicated hosted workflow below supplies scheduling and nightly publication. The current
local Installer runner still accepts stable versions only; its Mac finalizer separately accepts
dated nightly versions for use by CI.

## Hosted nightly workflow

`.github/workflows/nightly.yml` uses standard `macos-15`, `windows-2025`, and `ubuntu-24.04`
runners. It has no stable channel input, no npm publication, no Installer build, and no stable
version commit step. Publication rejects non-nightly tags and non-default branches, always sets
`prerelease=true` and `make_latest=false`, and verifies that GitHub's stable latest release did
not change. The native publication tests explicitly reject `v0.3.4`.

Manual proof run (builds and verifies both platforms without publishing):

```sh
gh workflow run nightly.yml --ref main -f publish=false
```

Manual nightly publication after the proof is healthy:

```sh
gh workflow run nightly.yml --ref main -f publish=true
```

The daily check is at **08:17 UTC**: about **01:17 Pacific daylight time / 00:17 Pacific standard
time**. GitHub can delay scheduled jobs. Scheduled builds require repository variable
`TRITONAI_NIGHTLY_ENABLED=1`; unset it or set it to `0` to pause them. An unchanged source commit
is skipped based on the last published nightly's resolved tag commit. Manual runs can rebuild
an unchanged commit. Pushes to the implementation branch run verification only.

Naming follows upstream T3 Code: `vNEXT_PATCH-nightly.YYYYMMDD.RUN_NUMBER`, with UTC date and the
GitHub run number. Because downstream package metadata can lag publication, CI uses the latest
published stable release as the baseline before calling the existing nightly resolver. For
example, stable `v0.3.3` produces `v0.3.4-nightly.20260912.42`, never stable `v0.3.4`.

### Nightly inputs

The workflow pins its Installer-owned composition producer and Mac finalizer with the exact
`NIGHTLY_INSTALLER_COMMIT` constant. That commit's reviewed plugin catalog supplies package IDs,
versions, and digests. Preparation happens before provider validation; validation runs on a
separate runner without signing or publication credentials. Packaging consumes that immutable
snapshot and its validation receipt. This does not change stable release repository variables.

Required repository secrets (values are never committed):

- `NIGHTLY_PLUGIN_CONFIGURATION_JSON`: exact configuration for the pinned plugin catalog.
- `NIGHTLY_UCSD_AI_BASE_URL`: managed API base URL.
- `NIGHTLY_MAC_CERTIFICATE`: base64-encoded Developer ID PKCS#12 identity.
- `NIGHTLY_MAC_CERTIFICATE_PASSWORD`: PKCS#12 password.
- `NIGHTLY_DEVELOPER_ID_APPLICATION`: expected Developer ID Application signer.
- `NIGHTLY_APPLE_API_KEY`, `NIGHTLY_APPLE_API_KEY_ID`, `NIGHTLY_APPLE_API_ISSUER`: notarization key and identifiers.

Mac signing uses a temporary runner keychain, removes signing inputs afterward, and verifies
signatures, notarization, Gatekeeper, plugin payloads, and isolated packaged-app boot before
upload. Windows retains its signed/unsigned mode checks; absent Azure configuration selects the
explicit unsigned nightly mode and is recorded in the release verification report and notes.
Partial Azure configuration fails. Stable Windows signing policy is unchanged.

Both platform jobs must pass along with quality checks before the read-only artifact gate
verifies exact filenames, byte sizes, hashes, nightly updater metadata, matching plugin
compositions, and platform reports. Only then can the publisher create a draft, upload assets,
and publish the nightly. Actions artifacts expire after three days. Failed publication leaves
a private nightly draft; inspect it before removing that failed draft and rerunning. Published
nightlies are never overwritten by the publisher.

### First hosted proof

[Run 34678772820](https://github.com/dbalders/TritonAI-Harness/actions/runs/34678772820) proved the
unsigned Mac ARM64 package on a standard hosted runner: approximately 5m09s total, including a
3m28s artifact build. This is not a signed/full-release benchmark. Initial checkout failed due
to an unmapped vendored gitlink; the root `.gitmodules` mapping fixes credential cleanup without
modifying the vendored source or retaining checkout credentials.

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
  managed-plugin composition. Its reviewed catalog supplies the exact Plugins ref, commit, package
  selection, versions, and digests.
- `TRITONAI_PLUGIN_CONFIGURATION_JSON`: bounded JSON object keyed by every package ID in the selected
  composition. Each plugin owns and validates its opaque configuration object.

The pinned Installer catalog is the only production plugin selection authority. Its preparation
step verifies that the catalog's Plugins ref resolves to the catalog's exact commit before staging
the approved bytes. A preparation job uploads that exact composition before any provider code
executes. A second, credential-free runner validates the immutable composition and emits a receipt
binding its source, contents, and exact configuration. The Windows build consumes those two
artifacts on a third fresh runner, verifies the receipt, and packages the composition without
executing provider code. The final proof manifest is a required release asset. Because the
composition is embedded in each Harness artifact, users who update Harness directly receive the
same managed plugins without running TritonAI Installer.

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
   For macOS, inspect both the main app and `TritonAI Harness Helper.app` with
   `codesign -d --entitlements :-` and require
   `com.apple.security.device.audio-input=true` before notarization.
4. Confirm the managed-plugin proof names the expected Installer and plugin commits.
5. Run packaged-app regression with an isolated profile, including first launch, provider startup,
   preview tools, managed plugins, and update presentation.
6. Confirm version-skew UI never offers a remote public-package update action.
7. Record remaining native/mobile or platform-specific gates separately.

Only after these checks should the Installer vendor and publish the Harness assets.

## Troubleshooting

- **Draft gate fails:** confirm the exact tag has an existing unpublished release and that nobody
  published it early.
- **Plugin pin check fails:** verify the Installer composition commit is exact and that its catalog
  Plugins ref still resolves to the catalog's stated commit.
- **Windows signing fails:** verify every Azure value and the expected publisher Common Name.
- **WSL backend artifact is missing:** rerun the Linux `node-pty` prerequisite and do not bypass the
  Windows build dependency.
- **Required asset pattern is missing:** inspect the packaging output and composition-proof step;
  do not publish a partial draft manually.
- **Version metadata finalization fails:** the release may still be valid, but `main` has not yet
  recorded the released version. Reconcile that state by PR before the next release.
