# Keeping TritonAI Harness Versions in Sync

The TritonAI Harness client and server work best when they use the same version. A mismatch appears
above the message box and in **Settings** → **Connections**.

## Desktop-managed servers

When the server belongs to an installed TritonAI Harness desktop app, update that app through the
normal TritonAI Installer or desktop update process on the machine running the server. The app keeps
this guidance informational and never starts a second server beside the desktop-owned process.

## Remote and headless servers

Automatic remote replacement is disabled in TritonAI Harness. Upstream servers may advertise
background-service or respawn capabilities, but those paths install the public `t3` npm package at
the client version. TritonAI product versions are not distributed through that package, so the
client deliberately ignores those capabilities and does not render or copy an npm update command.

Update a remote server through the same approved UCSD-managed distribution or deployment process
that provisioned it. Finish active agent work and terminal commands first because replacing a server
interrupts its connections.

Dismissing the version warning only hides that reminder for the two displayed versions. It does not
update either side.

## Update providers

The UCSD-managed Codex engine updates to the version approved in your Harness release on its own.
After Harness starts, it installs a pending engine update in the background unless a Codex session
is running. If that attempt is skipped or fails, update it from **Settings → Providers**. See
[TritonAI updates](updates.md) for the other update paths.

**Settings → Providers** shows provider updates for the selected environment. **Update all** updates
every outdated provider on every connected environment at once. Hover it to see which providers it
will update. Providers that only offer a manual update command are not included.
