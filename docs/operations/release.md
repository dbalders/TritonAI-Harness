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
draft remains unpublished after all automated Harness checks, Mac and Windows packaging, signing
verification, composition, and asset validation succeed. Tag pushes always leave a draft. Manual
runs default to `publish=false`; only an explicit `publish=true` publishes after validation.

The workflow:

1. resolves and validates the release version and exact tagged ref;
2. verifies the controlled release is still a draft;
3. runs `vp check`, typecheck, and the full test suite;
4. builds a Linux `node-pty` binary for the packaged Windows WSL backend;
5. validates the pinned Installer composition-producer commit;
6. asks that Installer commit to resolve and prepare its reviewed, digest-bound production
   managed-plugin catalog;
7. aligns package versions in the isolated build checkout;
8. authenticates the Windows runner through GitHub OIDC;
9. builds and signs the Windows x64 NSIS Harness artifact, then verifies its publisher and timestamp;
10. builds, signs, notarizes, and boot-verifies macOS arm64 on a hosted Mac runner using the
    same pinned Installer finalizer and immutable plugin composition as Windows;
11. finalizes the managed-plugin composition proofs;
12. uploads the Mac DMG/updater ZIP, Windows installer, blockmaps, updater metadata, and
    composition proofs;
13. downloads the final draft assets and verifies both updater manifests, artifact hashes,
    matching plugin composition, Mac ZIP permissions, and the source tag before publication;
14. leaves the verified draft available for testing by default; when explicitly dispatched with
    `publish=true`, publishes it, updates version metadata on `main`, and announces the release.

Stable and nightly workflows both build macOS and Windows on standard GitHub-hosted runners.
Stable uses the same signing credentials, plugin configuration, and managed API URL as nightly,
but stamps the stable version and produces stable app identity and update manifests. The
separate `nightly.yml` workflow cannot publish a stable release or update stable version metadata.

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

macOS Nightly must retain the historical `edu.ucsd.tritonai.harness` bundle ID.
Squirrel.Mac checks the replacement against the installed app's signing requirement,
so changing that ID breaks updates from earlier Nightly installations. Windows keeps
its separate `.nightly` app ID; the Nightly package name and data directory remain
separate on both platforms. Nightly `20260915.16` shipped the incompatible macOS ID;
users who manually installed that build need a separate recovery path. Validate
Mac release changes with an actual previous-version download, install, and relaunch,
in addition to packaged boot checks.

Before replacing an older installed Nightly, verify the signed updater ZIP against
that app's actual designated requirement. This read-only fixture checks the same
signing identity boundary used by Squirrel.Mac, including the signing team:

```sh
reference_app="/Applications/TritonAI Harness (Nightly).app"
candidate_zip="/absolute/path/to/TritonAI-Harness-VERSION-arm64.zip"
candidate_dir="$(mktemp -d)"
ditto -x -k "$candidate_zip" "$candidate_dir"
candidate_app="$candidate_dir/TritonAI Harness (Nightly).app"
requirement="$(codesign -d -r- "$reference_app" 2>&1 | sed -n 's/^designated => //p')"
test -n "$requirement" || exit 1
codesign --verify --deep --strict "$candidate_app" &&
  codesign --verify --strict "-R=$requirement" "$candidate_app"
```

Use an untouched `20260912.12` installation as the reference for this regression.
The published `20260915.16` ZIP passes the first signature check but fails the
second requirement check with `code failed to satisfy specified code requirement(s)`.
A compatible replacement must pass both. This fixture does not replace the subsequent
in-app download, quit, installation, and relaunch test.

Manual dispatch of the stable release workflow rejects Nightly versions. The dedicated hosted
workflow below owns scheduling and nightly publication. The current
local Installer runner still accepts stable versions only; its Mac finalizer separately accepts
dated nightly versions for use by CI.

## Hosted nightly workflow

`.github/workflows/nightly.yml` uses standard `macos-15`, `windows-2025`, and `ubuntu-24.04`
runners. It has no stable channel input, no npm publication, no Installer build, and no stable
version commit step. Publication rejects non-nightly tags and non-default branches, always sets
`prerelease=true` and `make_latest=false`, and verifies that GitHub's stable latest release did
not change. The native publication tests explicitly reject `v0.3.4`.

Nightly publication leaves a new tag absent until the fully verified draft is published.
It checks the draft's exact source SHA and revalidates any existing tag after uploads.
Creating a bare Nightly tag early exposes it in GitHub's Atom feed while its draft update
assets still return 404. Withdrawing an already published Nightly to draft can leave the
same broken feed entry; do not treat that action alone as a completed rollback. Verify
the public feed and manifest URLs after any release withdrawal.

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
upload. Windows nightlies require Azure OIDC authentication, signed artifacts, matching publisher,
and an Authenticode timestamp. Missing configuration or signing failures stop the build.
Stable Windows releases use the same OIDC signing policy.

The notarization key is created with a private umask in a subshell; app packaging
runs with `022`. The extracted signed updater ZIP must be readable
by other users, with traversable directories and runnable executables. Otherwise
an administrator-owned installation can appear empty and fail to relaunch even
though signing and a boot test under the build account passed. This gate does
not remove ShipIt or suppress administrator authorization for protected installs.

Both platform jobs must pass along with quality checks before the read-only artifact gate
verifies exact filenames, byte sizes, hashes, nightly updater metadata, matching plugin
compositions, and platform reports. Only then can the publisher create a draft, upload assets,
and publish the nightly. The publisher verifies uploaded asset names, sizes, completion state,
and SHA-256 digests against the validated local bytes, then verifies the Git tag before making
the draft public. A missing tag is created at the verified source commit; an existing tag at
another commit is rejected. Actions artifacts expire after three days. Failure before publication
leaves a private nightly draft; inspect it before removing that failed draft and rerunning.
Failure in a post-publication check can leave the release public: verify the actual release and
feed state before taking recovery action. Published nightlies are never overwritten by the publisher.

### Desktop update failure boundaries

Nightly checks allow downgrades within the Nightly track so its feed can offer an older release.
Stable checks disable downgrades. Packaged apps stay on their installed track; unpackaged mock
tooling retains an explicit channel-switch override. Account for older-version selection when
withdrawing a Nightly release or repairing its feed.

On macOS, a completed ZIP transfer is not installation readiness. The desktop waits for the
native Squirrel `update-downloaded` acknowledgement before offering restart. Further checks
are deferred while that native installer is staged, so a refresh cannot invalidate it.
Installation stops running backends but leaves windows intact for the updater to close.
An install failure restores those backends. The primary backend's readiness callback recreates
the main window if the native updater already closed it. Native failure after window closure,
including subsequent window-close and quit behavior, still requires an installed-app fault test.

macOS Stable and legacy Nightly still share the native ShipIt bundle identity and cache.
Separate JavaScript updater caches and profiles do not isolate that native installer. Do not
claim concurrent native updates are proven safe. Changing the bundle ID directly breaks the
legacy downloader, which matches both bundle ID and signing requirements. An automatic bridge
migration must be validated before changing this packaging contract; a direct installer probe
does not prove the complete download, quit, replacement, and relaunch sequence.

### First hosted proof

[Run 34678772820](https://github.com/dbalders/TritonAI-Harness/actions/runs/34678772820) proved the
unsigned Mac ARM64 package on a standard hosted runner: approximately 5m09s total, including a
3m28s artifact build. This is not a signed/full-release benchmark. Initial checkout failed due
to an unmapped vendored gitlink; the root `.gitmodules` mapping fixes credential cleanup without
modifying the vendored source or retaining checkout credentials.

## Draft-first publication sequence

1. Freeze the intended Harness commit and artifact contract.
2. Confirm the signing credentials, managed configuration, and pinned Installer commit.
3. Create an unpublished GitHub draft targeting the frozen commit.
4. Push the exact tag or create it through the GitHub API after the draft exists.
5. Dispatch the workflow for that version if tag creation did not already start it.
6. Wait for preflight, signed Mac and Windows builds, installed-app boot proof, managed-plugin proof, and required-asset checks.
7. Let the workflow validate Authenticode publisher identity and timestamps, then attach verified
   Mac and Windows assets while leaving the release as a draft.
8. Test those exact assets, explicitly publish the existing draft, and verify the published release
   state and downloaded asset identities.
9. Only then build and publish TritonAI Installer against those exact Harness assets.

Do not publish the draft manually while the workflow is running. Both preflight and the release job
fail closed if the controlled release is no longer a draft.

### Build a draft, then promote the tested files

After preparing the tag and draft above, dispatch:

```sh
gh workflow run release.yml --ref main -f version=0.3.4 -F publish=false
```

Wait for the workflow to succeed before downloading the draft assets with an authenticated
GitHub account. Install the Windows EXE over the previous stable installation to test the manual
upgrade path. An unpublished draft is not available to the normal public automatic updater;
that flow needs a separate test feed or a published release.

After testing, a maintainer or an explicitly authorized AI can promote the existing draft in
GitHub's release editor or with the CLI. Do not rerun packaging to promote a candidate: that would
replace the tested bytes. Freeze the draft during promotion: wait for every build/upload run to
finish and coordinate with other maintainers so nobody edits its tag or assets until publication
and downloaded-hash verification finish. GitHub does not provide an atomic compare-and-publish
operation; a script alone cannot prevent a concurrent authorized editor from replacing assets.
Before promotion, confirm the successful build's source SHA matches the
tag, the release is still a draft, and its assets have not changed since testing. Download them
again into an empty directory, compare the recorded test hashes, and run
`node scripts/verify-controlled-release-assets.cjs DIRECTORY 0.3.4` from the tagged checkout.
Then publish the stable release:

```sh
gh release edit v0.3.4 --repo dbalders/TritonAI-Harness --draft=false --prerelease=false --latest
```

Manual promotion does not execute this workflow's version-finalization or Discord jobs. Reconcile
release package versions through a PR if needed. Only build and publish TritonAI Installer after
Harness publication and asset verification.

For a release already authorized for immediate publication, manually dispatch with `-F publish=true`.
That run rebuilds both platforms, validates the complete asset set, publishes, finalizes versions, and
announces. It is not the promotion command for files already tested. Draft mode uses the same
signing and validation gates as immediate publication.

## Required downstream release pins

Repository variables:

- `TRITONAI_INSTALLER_COMPOSITION_COMMIT`: exact 40-character Installer commit that produces the
  managed-plugin composition. Its reviewed catalog supplies the exact Plugins ref, commit, package
  selection, versions, and digests.
  Shared stable/nightly repository secrets:

- `NIGHTLY_PLUGIN_CONFIGURATION_JSON`: bounded JSON object keyed by every package ID in the selected
  composition. Each plugin owns and validates its opaque configuration object.
- `NIGHTLY_UCSD_AI_BASE_URL`: managed API base URL.
- `NIGHTLY_MAC_CERTIFICATE`, `NIGHTLY_MAC_CERTIFICATE_PASSWORD`, and
  `NIGHTLY_DEVELOPER_ID_APPLICATION`: Developer ID signing identity.
- `NIGHTLY_APPLE_API_KEY`, `NIGHTLY_APPLE_API_KEY_ID`, and `NIGHTLY_APPLE_API_ISSUER`: notarization
  credentials. The historical secret names are shared; they do not select the runtime release track.

For promotion from a tested nightly, pin `TRITONAI_INSTALLER_COMPOSITION_COMMIT` to that nightly’s
`NIGHTLY_INSTALLER_COMMIT` so both platform builds use the same catalog and Mac finalizer.

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

### Stable and nightly GitHub OIDC setup

Both stable and nightly Windows jobs use the `windows-signing` GitHub environment and `azure/login`.
Create an Entra app registration and service principal dedicated to Harness releases, then add
an OIDC federated credential with issuer `https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`, and subject
`repo:dbalders/TritonAI-Harness:environment:windows-signing`.
Assign that service principal **Artifact Signing Certificate Profile Signer** at this resource:

```text
/subscriptions/3e0cad08-e45d-4882-a3aa-c1504d4e5017/resourceGroups/TritonAI/providers/Microsoft.CodeSigning/codeSigningAccounts/ucsd-tritonai-signing/certificateProfiles/tritonai-public
```

Create the `windows-signing` environment in GitHub Settings > Environments. Allow deployments from `main` and release tags matching `v*.*.*` (configure separate branch and tag rules); temporarily permit the reviewed signing branch for the first non-publishing test,
then remove that exception. Configure these environment variables:

| Variable                                         | Value                                         |
| ------------------------------------------------ | --------------------------------------------- |
| `AZURE_CLIENT_ID`                                | Application ID of the dedicated Entra app     |
| `AZURE_TENANT_ID`                                | `8a198873-4fec-4e76-8182-ca479edbbd60`        |
| `AZURE_SUBSCRIPTION_ID`                          | `3e0cad08-e45d-4882-a3aa-c1504d4e5017`        |
| `AZURE_TRUSTED_SIGNING_ENDPOINT`                 | `https://wus2.codesigning.azure.net/`         |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`             | `ucsd-tritonai-signing`                       |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | `tritonai-public`                             |
| `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`           | `The Regents of the University of California` |

No client secret is needed. The packager uses `AZURE_TRUSTED_SIGNING_USE_AZURE_CLI=true`
to accept the authenticated runner session. Signing still fails if that session cannot sign.
Electron Builder signs during packaging, before generating updater hashes and blockmaps.
The runner checks signatures and timestamps, installs the package, runs a silent update over
that installation, and boots the upgraded app. A fresh install alone does not exercise the
old uninstaller. Release and nightly verification also run the native directory-swap
regression with the packaging compiler. It can be run separately on Windows with
`./scripts/verify-windows-upgrade-directory-swap.ps1 -MakensisPath <path-to-makensis.exe>`;
it uses disposable payloads and covers legacy, completed, and interrupted installations.
The final
nightly artifact gate rejects unsigned Windows reports. Stable publication depends on the successful
signed Windows build and its installed-app verification.

First dispatch `nightly.yml` from the reviewed branch with `publish=false`. Confirm the Windows
signing, Authenticode, installed-app boot, and final artifact gates pass. Only then merge and
allow scheduled publication. Local tests cannot establish Azure permissions or Windows trust.

Stable tag-triggered runs require the tag rule on the environment; allowing `main` alone does not
allow tag deployments. Manual stable runs retain their controlled draft and tagged-source checks.
The stable workflow defaults to a draft build and does not publish unless a manual dispatch sets
`publish=true`. Both modes validate stable signing against the controlled release. The shared
packager still supports client-secret authentication for local callers,
but neither GitHub release workflow uses it or permits unsigned fallback.

## Required release assets

The release job refuses publication unless every required platform pattern matches:

- `*.dmg`
- `*.zip`
- `*.exe`
- `*.blockmap`
- updater `*.yml`
- `tritonai-plugin-composition-*.json`

Both platforms must match the frozen artifact contract. A workflow success
proves the automated build and boot checks and asset validation (plus publication when explicitly selected);
it does not by itself prove the full upgrade path or runtime behavior on either platform.

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

## macOS in-app update validation

Launch the installed app through Finder, Dock, or LaunchServices for update UAT. Do not run
`Contents/MacOS/TritonAI Harness` directly to represent a normal user launch. Squirrel checks
whether the running process can write to its app bundle and parent directory before choosing
between a per-user ShipIt job and privileged helper authorization. File ownership and a
writability check from a separate shell process do not establish what the app process sees.

For a local feed serving the exact signed release assets, quit the installed app first and pass
the test variables only to the new LaunchServices process (replace the port with the feed's port):

```sh
/usr/bin/open -a "/Applications/TritonAI Harness.app" \
  --env T3CODE_DESKTOP_MOCK_UPDATES=true \
  --env T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT=18448
```

Confirm the feed metadata and ZIP checksum match the intended release. Download, install, and
restart through the app UI. Verify the installed version and signature, successful ShipIt
installation/relaunch, and preservation of the original draft and configuration. Quit and reopen
normally after testing if the current process still uses the test feed; stop the local feed when
finished. Do not edit the signed bundle's `app-update.yml` to redirect updates.

If an “add a new helper tool” prompt appears, cancel it during diagnosis. Record the launch method,
actual target in `~/Library/Caches/edu.ucsd.tritonai.harness.ShipIt/ShipItState.plist`, and ShipIt and
macOS authorization logs. Repeat a direct-executable test through LaunchServices before attributing
the prompt to packaging or ownership. A controlled 0.3.3 → 0.3.4 validation completed with a per-user
ShipIt job and no helper prompt after this launch change, using the same signed update payload.
That result does not guarantee prompt-free updates under every installation policy. Do not change
permissions, TCC, or signature checks to make a release test pass.

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
