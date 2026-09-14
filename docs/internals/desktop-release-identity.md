# Desktop release identity

Stable retains `edu.ucsd.tritonai.harness` and package name `tritonai-harness` for upgrade compatibility.
Nightly uses `edu.ucsd.tritonai.harness.nightly` and `tritonai-harness-nightly`.
The shared TritonAI identity resolver drives packaging and runtime identity.

Electron Builder derives the NSIS application GUID and uninstall registration from `appId`,
and the per-user install directory and updater cache from the package name. Changing only
`productName` leaves these identities shared. Nightly keeps its existing display name and artwork.

Nightly uses `~/.tritonai-harness-nightly` for backend state and a separate Electron profile,
single-instance lock, and `tritonai-harness-nightly://app` renderer/OAuth origin. It never adopts
stable's legacy Electron profile. WSL expands the same Nightly home inside its selected distro.
Explicit `TRITONAI_HOME`/`T3CODE_HOME` overrides retain their existing meaning; operators must choose
separate overrides if they run both apps. Project files and external provider installations are
outside the profile-isolation boundary.

Packaged apps ignore saved cross-track preferences and reject cross-track updater IPC requests.
Unpackaged mock-update tooling retains channel switching. The desktop About panel displays the
installed track; the hosted web channel selector remains independent.

This is an intentional TritonAI distribution difference from upstream T3 Code, which currently
shares stable/Nightly package identity and profile paths. It uses the existing packaging,
environment, protocol, and updater boundaries; future upstream syncs must preserve these values.
Legacy Nightly installs are not automatically migrated or uninstalled because their shared registry
entry and data cannot safely be distinguished from stable. Native Windows validation should cover
stable installed/running, first Nightly install, Nightly-to-Nightly upgrade, same-version reinstall,
and either app's uninstall while preserving the other app and its profile.
