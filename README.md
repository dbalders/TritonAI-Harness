# TritonAI Harness

TritonAI Harness is a UCSD-oriented desktop/web harness for Codex app-server. It keeps TritonAI provider configuration separate from a user's normal Codex setup while presenting a constrained Codex-first model surface.

## Installation

> [!WARNING]
> TritonAI Harness currently targets Codex app-server only.
> Install Codex and configure the TritonAI provider/model settings before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`

### Run without installing

```bash
npx t3@latest
```

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install TritonAI Harness from the TritonAI fork's GitHub Releases once branded release assets are published. Do not publish upstream T3 Code release assets as TritonAI Harness releases.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

There's no public docs site yet, checkout the miscellaneous markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Codex provider guide](./docs/providers/codex.md)
- [TritonAI downstream operations](./docs/tritonai-downstream.md)
- [TritonAI sync automation](./docs/tritonai-sync-automation.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

TritonAI Harness uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
