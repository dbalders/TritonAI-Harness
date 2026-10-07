# Install TritonAI Harness

TritonAI Harness runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

Install TritonAI Harness with the
[latest TritonAI Installer release](https://github.com/dbalders/TritonAI-Installer/releases/latest).
The Installer sets up the desktop app, the UCSD-managed Codex runtime and its Node.js runtime,
TritonAI provider settings, and UCSD skills. Rerun it to repair the managed runtime.

Do not use the public `t3` npm package, the `t3.codes` install scripts, or the upstream T3 Code
package-registry builds. They install upstream T3 Code, not the UCSD-managed TritonAI Harness
distribution.

The managed Codex provider is ready after the Installer finishes. You can launch TritonAI Harness
and enable other providers afterwards.

## Desktop app

TritonAI Harness ships separate Stable and Nightly desktop apps for macOS and Windows. After
installation, update the app from **Settings → About → Check for Updates**. See
[TritonAI updates](./updates.md) for how app, engine, and skill updates are delivered.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install Node.js and any additional provider CLIs inside that distro.

The desktop app installs the matching server runtime into `~/.tritonai-harness/wsl-runtime`
inside the selected distro. The first launch after installing or updating TritonAI Harness may
take a little longer while that release's runtime is extracted. Later launches reuse the
Linux-local copy so startup does not depend on reading application files through `/mnt/c`. After
a successful launch, TritonAI Harness keeps the current runtime and one previous runtime for
rollback and removes older caches automatically. If a cached runtime stops working, TritonAI
Harness launches from the application files under `/mnt/c` instead and reinstalls the runtime on
the next launch.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

The phone connects to a TritonAI Harness server on another machine. Follow
[remote access](./remote-access.md) to link it with a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and include it
when reporting the problem. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Installed and configured by TritonAI Installer. See [Codex](./providers-codex.md) and [TritonAI access keys](./tritonai-access-keys.md). |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                             |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                    |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                       |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                 |
| Antigravity | Install and sign in with Google from TritonAI Harness provider settings.                                                                 |

Provider CLIs must be on the server's `PATH`. If TritonAI Harness cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. The managed Codex provider and Antigravity can use their managed
runtimes without a `PATH` entry.

TritonAI Harness warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified. Use TritonAI
Installer to repair the managed Codex runtime.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when TritonAI Harness can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, TritonAI Harness does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [TritonAI updates](./updates.md): update the app, managed engine, and skills.
- [Keeping TritonAI Harness versions in sync](./updating.md): client and server version skew.
