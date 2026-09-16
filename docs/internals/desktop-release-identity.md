# Desktop release identity

Stable retains `edu.ucsd.tritonai.harness` and package name `tritonai-harness` for upgrade compatibility.
Nightly uses package name `tritonai-harness-nightly` and a distinct Windows application ID,
`edu.ucsd.tritonai.harness.nightly`. macOS packaging currently retains the historical
`edu.ucsd.tritonai.harness` bundle ID so legacy Squirrel installations can accept updates.
The shared identity resolver drives runtime identity; macOS packaging overrides its bundle ID.

The macOS exception also shares Squirrel's ShipIt job label and state-file directory between
Stable and Nightly. Profile isolation does not provide native-updater isolation. Automatic
migration to a distinct Nightly bundle ID requires a compatible bridge: the legacy downloader
selects an app by bundle ID before checking its signing requirement. Re-signing a different
bundle ID with the legacy code-signing identifier alone cannot pass that download step.
No automatic identity migration is implemented in the current desktop code.

Electron Builder derives the NSIS application GUID and uninstall registration from `appId`,
and the per-user install directory and updater cache from the package name. Changing only
`productName` leaves these identities shared. Nightly keeps its existing display name and artwork.

Nightly uses `~/.tritonai-harness-nightly` for backend state and a separate Electron profile,
single-instance lock, and `tritonai-harness-nightly://app` renderer/OAuth origin. It never adopts
stable's legacy Electron profile. WSL expands the same Nightly home inside its selected distro.
For an explicit `TRITONAI_HOME`/`T3CODE_HOME`, stable retains the configured directory and Nightly
uses its `nightly` subdirectory. A shared machine-level override therefore keeps their backend
state separate. Development overrides retain their existing meaning. Project files and external
provider installations are outside the profile-isolation boundary.

Codex startup retains a working configured command. If the default `codex` command or an
Installer-managed launcher cannot start, the server discovers installed packages under
`~/.agents/ucsd/runtime/codex/openai-codex-*`. It checks package identity, orders candidates by
their actual installed version (engine updates can retain an older directory name), and verifies
the launcher with a bounded `--version` process before using it for catalogs, sessions, status,
text generation, plugin and skill management, and engine maintenance. Explicit custom commands
are never replaced.
Discovery does not import another profile's settings or alter its data, credentials, or Codex home.
The Installer remains responsible for installing and repairing the runtime; discovery does not
download packages or persist a fallback path that could become stale after another installation.

New managed profiles with no settings file or Codex conversation history default their Codex home
to `<profile base>/codex`, including custom base directories. Initial settings persist that home
in the policy marker before conversations can start.
Runtime identity comes from that profile's document rather than a process-global migration side effect.
Existing settings files retain their saved Codex home or the historical implicit
`~/.tritonai-harness/codex` home. An empty or malformed existing file is treated conservatively as
legacy state, as is a profile with Codex conversation history but no settings file. This does not
move existing sessions or silently split shared history.

The Codex engine installation remains shared by profiles that resolve to the same executable.
Updating that engine changes the version used by those profiles; profile isolation does not
provide independent engine versions.

Packaged apps ignore saved cross-track preferences and reject cross-track updater IPC requests.
Unpackaged mock-update tooling retains channel switching. The desktop About panel displays the
installed track; the hosted web channel selector remains independent.

This is an intentional TritonAI distribution difference from upstream T3 Code, which currently
shares stable/Nightly package identity and profile paths. It uses the existing packaging,
environment, protocol, and updater boundaries; future upstream syncs must preserve these values.
Legacy Windows Nightly installs are not automatically migrated or uninstalled because their shared registry
entry and data cannot safely be distinguished from stable. Native Windows validation should cover
stable installed/running, first Nightly install, Nightly-to-Nightly upgrade, same-version reinstall,
and either app's uninstall while preserving the other app and its profile.
