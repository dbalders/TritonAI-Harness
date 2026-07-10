# TritonAI Sync Automation

This automation keeps the TritonAI Harness downstream branch close to upstream `pingdotgg/t3code` while preserving TritonAI branding, Codex-first runtime behavior, and UCSD provider/model constraints.

## Moving Parts

- `scripts/tritonai-sync-upstream.mjs`
- `.github/workflows/tritonai-upstream-sync.yml`
- `bun run tritonai:sync:check`
- `bun run tritonai:sync:review`
- `bun run tritonai:sync:pr`
- `scripts/tritonai-release-sync.mjs`
- `bun run tritonai:release-sync:pr`

The upstream sync script evaluates merges in a detached temporary worktree and publishes generated
`sync/upstream-*` branches only when requested. The parent release sync script uses generated
`sync/release-*` branch names so release PRs cannot overwrite ordinary upstream sync PRs.

## Review Modes

For a no-model dry check:

```sh
bun run tritonai:sync:check
```

For Codex review:

```sh
export TRITONAI_SYNC_AGENT_COMMAND='codex exec "$(cat "$TRITONAI_SYNC_AGENT_PROMPT_FILE")" > "$TRITONAI_SYNC_AGENT_RESPONSE_FILE"'
bun run tritonai:sync:review
```

For PR creation:

```sh
bun run tritonai:sync:pr
```

The agent command receives:

- `TRITONAI_SYNC_AGENT_PHASE`
- `TRITONAI_SYNC_AGENT_PROMPT_FILE`
- `TRITONAI_SYNC_AGENT_RESPONSE_FILE`
- `TRITONAI_SYNC_AGENT_CAN_EDIT`

The command should write only the final JSON response to `TRITONAI_SYNC_AGENT_RESPONSE_FILE`.
Approval is represented by an `"approved": true` field. A skipped, failed, risky, or
unconfigured review always leaves the sync in `needs-human-review`.

## Secret Handling

Validation checks run with token-like environment variables removed. Agent review also receives a stripped environment. The default agent secret allowlist is:

```text
CODEX_HOME,TRITONAI_HOME,TRITONAI_API_KEY
```

Override it with:

```sh
export TRITONAI_SYNC_AGENT_SECRET_ENV_ALLOWLIST="CODEX_HOME,TRITONAI_HOME,TRITONAI_API_KEY"
```

This lets a Codex review command use the intended TritonAI/Codex configuration without leaking GitHub tokens or unrelated API keys into upstream package scripts.

## Labels

Generated PRs use these managed labels when applicable:

- `automation:upstream-sync`
- `automation:release-sync`
- `needs review`
- `upstream-conflict`
- `checks-failed`

The label sync workflow creates or updates those labels.

## Hard Gates

The automation will not mark a sync as review-ready unless:

- The upstream merge completed cleanly.
- Checks passed.
- Codex review approved the merge.

If checks or review are skipped, failed, missing, or risky, the result stays
`needs-human-review`. The automation can create a ready-for-review PR, but it never
enables or performs auto-merge.

## GitHub Workflow

`.github/workflows/tritonai-upstream-sync.yml` is scheduled and manually dispatchable. It expects a self-hosted runner because the fork may need local Codex/TritonAI configuration. The workflow can push a sync branch and open a ready-for-review PR, but it cannot merge it.

Both sync scripts use `t3code-upstream` as a verified fetch-only parent remote.
They refuse a mismatched fetch URL and enforce `pushurl=DISABLED` before fetching.

## Parent Release Sync

`scripts/tritonai-release-sync.mjs` is adapted from the T3Code fork's release sync helper. It finds the latest stable GitHub release from `pingdotgg/t3code`, merges that tag into the configured TritonAI Harness downstream branch, runs `TRITONAI_RELEASE_SYNC_CHECKS`, and can push/open a review PR.

The default downstream branch in this repo is `main`. Override it with:

```sh
export TRITONAI_RELEASE_SYNC_DOWNSTREAM_BRANCH=main
```

## Mobile Workflow Alignment

`.github/workflows/mobile-eas-preview.yml` matches current parent `main`. Its
label gate and `EXPO_TOKEN` preflight make the workflow a safe no-op when the
downstream repository has no Expo secret.

The current parent `.github/workflows/mobile-eas-production.yml` is intentionally
excluded. It can build and auto-submit to TestFlight or publish a production OTA
update, which crosses TritonAI's explicit release/publishing authority boundary.
That production workflow should only be adopted with a separate downstream
mobile release decision and credential plan.
