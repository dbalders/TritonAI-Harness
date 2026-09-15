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

New managed profiles default their Codex home to `<profile base>/codex`, including profiles with
no settings file, an empty file object, or a custom base directory. Runtime identity comes from
that profile's persisted document rather than a process-global migration side effect. Saved
Codex home paths remain authoritative: this does not move existing sessions or silently split
an intentionally shared history. A legacy profile that already saved a shared Codex home keeps it.

Harness engine updates and TritonAI Installer coordinate through an exclusive SQLite transaction
on `.tritonai-codex.lock.sqlite` in the shared runtime root. The OS releases the lock on process
exit; the lock file is never deleted. A competing operation fails with a retry message.
The updater validates the staged engine's version, model catalog, and app-server support before
activation, then verifies the activated managed launcher before committing. A durable
`.tritonai-codex-update.json` journal retains the old runtime until that commit. Cancellation
rolls back; the next Harness startup or Installer run recovers a process crash. Recovery failures
preserve the journal and backup. Installer-owned interrupted transactions are repaired by rerunning
Installer. Both apps still share the engine version; protocol checks are not a promise of arbitrary
future engine compatibility. Older releases must be upgraded to participate in this lock protocol.

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
