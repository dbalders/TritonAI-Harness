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

### The `t3` command

The desktop app includes the `t3` command-line tool. To run it from any
terminal, open **Settings → About** and choose **Install** next to
**t3 command**. On macOS and Linux it adds a `t3` link to a folder on your
`PATH`; on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. **Remove** takes it off again. If you already have a `t3`
command on your `PATH`, it stays as it is.

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

On iPhone or iPad, install [TritonAI Harness Preview through TestFlight](https://testflight.apple.com/join/7fUqZU3C).
The same invitation is available as a link and QR code under **Settings → About → Mobile app**
in the desktop and web app.

The phone connects to a TritonAI Harness server on another machine. Follow
[remote access](./remote-access.md) to link it with a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and include it
when reporting the problem. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Managed Harness installations expose Codex connections in **Settings → Runtime**.
The provider guides below also describe inherited adapters, available when your installation
and policy enable them. Provider installation, login, and configuration belong to the
environment's machine, even when you connect from a phone or another computer.

| Provider    | Install and authenticate                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Installed and configured by TritonAI Installer. See [Codex](./providers-codex.md) and [TritonAI access keys](./tritonai-access-keys.md). |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                             |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                    |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                       |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                               |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                 |
| Antigravity | Install and sign in with Google from TritonAI Harness provider settings.                                                                 |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                       |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.         |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                       |

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
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when Harness cannot tell. Harness runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Cursor and Antigravity update with Harness. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, TritonAI Harness does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [TritonAI updates](./updates.md): update the app, managed engine, and skills.
- [Keeping TritonAI Harness versions in sync](./updating.md): client and server version skew.
- [Background service distribution policy](./background-service.md): approved managed server paths.
- [Managed policy](./managed-policy.md): configure Harness for everyone on a machine.
