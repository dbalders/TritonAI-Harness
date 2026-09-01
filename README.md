# TritonAI Harness

TritonAI Harness is UCSD's downstream fork of [T3 Code](https://github.com/pingdotgg/t3code).
It is an agent-harness control surface for desktop, web, and mobile, with
UCSD/TritonAI defaults, a Codex-first model surface, and configuration that stays
separate from a user's normal Codex setup. The inherited runtime can control
authenticated Codex, Claude Code, Cursor, Grok Build, and OpenCode providers.

This is not a clean-room rewrite. The repo keeps the upstream T3 Code history and MIT license so the original work stays visible. TritonAI release assets and installer behavior are maintained separately from upstream T3 Code.

TritonAI Harness was created by David Balderston as a UC San Diego-focused distribution of T3 Code and is maintained separately from the upstream project.

## Installation

Install from the [latest TritonAI-Installer release](https://github.com/dbalders/TritonAI-Installer/releases/latest). That installer sets up TritonAI Harness, the managed Codex backend, TritonAI provider settings, and UCSD skills.

Do not use the upstream T3 Code npm package for TritonAI Harness. It is not the UCSD-managed install path.

## Status

This is still early. Expect bugs.

TritonAI Commons accepts public skill contributions through Harness. Outside product-code PRs are not being accepted right now.

There is no public docs site yet. Use the markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Remote access](./docs/user/remote-access.md)
- [Keeping TritonAI Harness versions in sync](./docs/user/server-updates.md)
- [Computer use](./docs/user/computer-use.md)
- [TritonAI Commons](./docs/user/tritonai-commons.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Codex provider guide](./docs/providers/codex.md)
- [TritonAI downstream notes](./docs/tritonai-downstream.md)
- [TritonAI sync automation](./docs/tritonai-sync-automation.md)
- [Operations](./docs/operations/ci.md)
- [Secret storage](./docs/operations/secret-storage.md)
- [Reference](./docs/reference/encyclopedia.md)

## Local development

### Install `vp`

TritonAI Harness uses Vite+, so install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Vite+ docs: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue.
