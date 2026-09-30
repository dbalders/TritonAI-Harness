# TritonAI Harness

TritonAI Harness is a UC San Diego-focused AI workspace for desktop, web, and mobile, built on [T3 Code](https://github.com/pingdotgg/t3code).

[Install](#installation) · [Vision and roadmap](#vision-and-roadmap) · [Documentation](#documentation) · [Local development](#local-development)

## Installation

Install from the [latest TritonAI-Installer release](https://github.com/dbalders/TritonAI-Installer/releases/latest). That installer sets up TritonAI Harness, the managed Codex backend, TritonAI provider settings, and UCSD skills.

Do not use the upstream T3 Code npm package for TritonAI Harness. It is not the UCSD-managed install path.

## Status

This is still early. Expect bugs.

TritonAI Commons accepts public skill contributions through Harness. Outside product-code PRs are not being accepted right now.

There is no public docs site yet. Use the markdown files in [docs](./docs).

## Vision and roadmap

We're building a dependable UCSD AI workspace, integrated with TritonAI, that understands your work and helps you get things done—whether you've never written code or build software every day.

The goal is one straightforward place to find answers, work with your department, create useful tools, and complete everyday tasks. It should be approachable on your first day and useful enough to become part of your daily work.

![Proposed roadmap across Now, Next, Later, and Exploring, grouped into getting started, work context, collaboration, creation, and campus service. A full text version follows.](docs/images/citizen-developer-roadmap.svg)

_These are planned outcomes. Now, Next, Later, and Exploring describe priorities—not promised delivery dates or a list of features already available._

<details>
<summary><strong>Read the roadmap as text</strong></summary>

- **Now:** TritonAI Guide, easy onboarding, connected tools, and reliable releases.
- **Next:** Personal memory, role assistants, department knowledge, shared projects, and practical SOPs.
- **Later:** Dependable automation, citizen-built tools, campus readiness, and proactive assistance.
- **Exploring:** Experiences tailored to your role, including where specialized guidance or models meaningfully improve the work.

</details>

## Current priorities

**Our next milestone is a useful first day.** Someone can open the app, connect a work source, complete a real task, and come back to continue.

### Help me get started

TritonAI Guide and onboarding should help people take the next step in ordinary language. Ask how something works, get help connecting a tool, or troubleshoot a problem with guidance grounded in the actual application.

### Connect the work I already do

Bring useful knowledge and tools into the workspace. Make permissions understandable, connections dependable, and recovery straightforward when something goes wrong.

### Make it dependable

Install and update smoothly. Preserve work through interruptions. Make errors understandable and show whether an action succeeded.

**Success means a new user completes a useful task without needing a developer beside them.**

## What we will hold ourselves to

- **Easy to use:** a clear starting point, useful help, and room to grow into advanced capabilities.
- **Dependable:** work persists, failures are understandable, and important actions have a clear result.
- **Grounded in your work:** relevant sources, inspectable memory, and clear boundaries between personal and shared information.
- **Under your control:** understand permissions, correct remembered information, and choose what to share or automate.
- **Built for campus:** accessibility, department needs, and sustainable support are part of the experience.

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Remote access](./docs/user/remote-access.md)
- [Keeping TritonAI Harness up to date](./docs/user/updates.md)
- [Computer use](./docs/user/computer-use.md)
- [TritonAI Commons](./docs/user/tritonai-commons.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Codex provider guide](./docs/user/providers-codex.md)
- [TritonAI downstream notes](./docs/tritonai-downstream.md)
- [TritonAI sync automation](./docs/tritonai-sync-automation.md)
- [Operations](./docs/operations/ci.md)
- [Secret storage](./docs/operations/secret-storage.md)
- [Glossary](./docs/internals/glossary.md)

## About this repository

TritonAI Harness is UCSD's downstream fork of [T3 Code](https://github.com/pingdotgg/t3code).
It is an agent-harness control surface for desktop, web, and mobile, with
UCSD/TritonAI defaults, a Codex-first model surface, and configuration that stays
separate from a user's normal Codex setup. The inherited runtime can control
authenticated Codex, Claude Code, Cursor, Grok Build, and OpenCode providers.

This is not a clean-room rewrite. The repo keeps the upstream T3 Code history and MIT license so the original work stays visible. TritonAI release assets and installer behavior are maintained separately from upstream T3 Code.

TritonAI Harness was created by David Balderston as a UC San Diego-focused distribution of T3 Code and is maintained separately from the upstream project.

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
