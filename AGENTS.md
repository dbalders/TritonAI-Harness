# TritonAI Harness Agent Instructions

## Project

TritonAI Harness is the active product source of truth for the TritonAI desktop,
web, mobile, server, and shared runtime surfaces. It is downstream of
`pingdotgg/t3code`; keep intentional TritonAI and UCSD behavior explicit while
preserving a practical path for future upstream merges.

`TritonAI-Installer` is the separate source of truth for installer packaging and
managed-machine setup. Do not move installer-owned behavior into this repo.

## Completion Requirements

- Run `vp check` and `vp run typecheck` before considering a change complete.
- Run `vp test` for the built-in Vite+ test command. Use `vp run test` only when
  the package-script test entrypoint is specifically required.
- If native mobile code changes, also run `vp run lint:mobile`.
- For release or packaging changes, run the relevant release smoke checks and
  record the exact source commit used.
- Report checks that were not run and why; never imply that skipped checks passed.

## Engineering Priorities

1. Reliability and predictable recovery during reconnects, restarts, partial
   streams, and provider failures.
2. Correctness and security at provider, credential, process, and repository
   boundaries.
3. Performance under realistic concurrent session load.
4. Maintainability and limited downstream divergence.

Prefer shared, testable modules over duplicated local fixes. Keep contracts and
runtime behavior separate, and avoid unrelated formatting or renaming churn that
makes upstream reconciliation harder.

## Package Roles

- `apps/server`: Node.js WebSocket server, Codex app-server integration, provider
  sessions, orchestration, relay, and backend services.
- `apps/web`: React/Vite session UI, conversation rendering, settings, and
  client-side state.
- `apps/desktop`: Desktop packaging and runtime integration for the Harness app.
- `apps/mobile`: Mobile application code and native projects.
- `packages/contracts`: Schema-only shared contracts for provider events,
  WebSocket protocol, models, and sessions.
- `packages/shared`: Shared runtime utilities exposed through explicit subpath
  exports; do not add a barrel index.
- `packages/client-runtime`: Shared client behavior used by web and mobile.

## Upstream Alignment

- Before introducing a broad refactor, compare the affected surface with
  `pingdotgg/t3code` and document why downstream divergence is necessary.
- Accept downstream differences for TritonAI branding, provider/model policy,
  UCSD integration, local Codex behavior, security, and release control.
- Avoid copying tooling or runtime logic when the upstream-compatible shape can
  be extended cleanly.
- Upstream-sync pull requests must remain human-reviewable and must not treat
  skipped checks or skipped AI review as approval.

## Reference Repositories

- OpenAI Codex: https://github.com/openai/codex
- Codex Monitor: https://github.com/Dimillian/CodexMonitor

Use these for protocol, UX, and operational patterns; do not copy behavior
without checking compatibility with Harness requirements.

## Vendored Repositories

Repositories under `.repos/` are read-only references for agents.

- Prefer their real examples over generated guesses.
- Do not edit or import application code from `.repos/` unless explicitly asked.
- Manage configured mirrors with `bun run sync:repos` or
  `bun run sync:repos --repo <id>`.
- When updating a dependency with a configured mirror, update the mirror in the
  same change.
- Read `.repos/effect-smol/LLMS.md` before writing Effect code and inspect the
  vendored examples for idiomatic APIs and tests.
- Inspect `.repos/alchemy-effect/` before changing Alchemy relay infrastructure.
