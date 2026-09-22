# TritonAI updates

TritonAI uses separate update paths so routine changes do not require rerunning the full Installer.

- **Harness application:** use **Settings > About > Check for Updates**. A Harness update also carries UCSD-managed configuration, built-in skills, and the managed plugin composition.
- **Managed Codex CLI:** TritonAI checks the installed Codex provider version. When an update is available, use the provider update action in the sidebar or provider settings. The update is staged, verified, activated transactionally, and checked again by Harness.
- **Managed secure skills:** when a Harness release configures the authenticated secure-skills endpoint, Harness checks it at startup and on the configured polling interval. Only skills owned by the managed-skills manifest are replaced.
- **Public and community skills:** the catalog refreshes automatically. Installed copies remain user-controlled; remove and add a skill again to refresh its installed copy.
- **Managed Node.js runtime:** use the full TritonAI Installer when Node must change or when the managed runtime needs repair.

If a Codex update cannot run on the current managed Node.js version, no staged update is activated. Run the latest full Installer to update or repair the managed runtime, then retry from Harness.

Windows loads the credentials saved by TritonAI Installer when you open Harness directly or restart after an update. Credentials saved in Harness settings take precedence.

On Windows, managed engine updates use the Node.js and npm installed by TritonAI Installer, including when Harness is opened directly. You do not need to add them to your system PATH. Updates allow a short retry period when Windows temporarily locks engine files during verification.

## Stable and Nightly

Stable and Nightly have separate desktop apps and data profiles. **Settings > About** shows the installed app's update track:
stable receives stable releases, and Nightly receives Nightly releases.

On macOS, existing releases share part of the system updater. Finish updating one app before
starting an update in the other. Once an update is ready, install it before checking for another.
Nightly can update to an older Nightly version when that is the version offered by its feed.

macOS validates downloaded updates before offering restart. If installation fails before the
updater closes the app, its window remains open and its local server restarts so you can retry.
An administrator-owned installation may still require macOS authorization to replace it.

Nightly starts with its own chats, settings, sign-in sessions, and local server data. It does not
copy or move your stable profile. Shared project folders and external services remain shared when
you choose to use them from both apps.

If you configured a custom data home with `TRITONAI_HOME` or `T3CODE_HOME`, Nightly uses a `nightly`
subfolder there so the two apps still keep separate data.

Older Nightly installers used the stable installation identity. If one already replaced or
partially removed stable, installing a corrected Nightly build does not restore stable's application
files. Keep your existing data and reinstall stable separately; do not delete all TritonAI profiles
or uninstall TritonAI Installer as a Nightly setup step.

## Nightly and Dev appearance

The development app now uses a white trident over teal Aurora waves, matching the circular main and nightly icons.

In web and desktop, **Settings > Appearance > Show header artwork** controls the decorative Nightly and Dev artwork. It is on by default. Turn it off for a plain header; the **(Nightly)** or **(Dev)** label stays visible. Your choice is saved and can be changed at any time. The artwork preference applies to every theme. Stable builds hide the artwork, environment label, and artwork setting, including its search result.

UCSD-managed Codex engine updates follow the version approved in your Harness release. A newer upstream Codex release alone does not trigger an update. Harness offers an engine update only when the approved version is available and newer than your installed engine; it never downgrades a newer installation. If approval information is unavailable, managed engine updates stay disabled. Personal and custom provider updates retain their usual behavior.
