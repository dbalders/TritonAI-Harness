# TritonAI Sync Automation

This automation keeps the TritonAI Harness downstream branch close to upstream `pingdotgg/t3code` while preserving TritonAI branding, Codex-first runtime behavior, and UCSD provider/model constraints.

## Moving Parts

- `scripts/tritonai-sync-upstream.mjs`
- `.github/workflows/tritonai-upstream-sync.yml`
- `bun run tritonai:sync:check`
- `bun run tritonai:sync:review`
- `bun run tritonai:sync:pr`
- `bun run tritonai:sync:auto`
- `scripts/tritonai-release-sync.mjs`
- `bun run tritonai:release-sync:pr`

The upstream sync script creates generated `sync/upstream-*` branches in a temporary worktree. The parent release sync script uses generated `sync/release-*` branches so release PRs cannot overwrite ordinary upstream sync PRs.

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
- `automation:auto-merge-ready`
- `needs-human-review`
- `upstream-conflict`
- `checks-failed`
- `ai-review-risk`
- `agent-attempted`

The label sync workflow creates or updates those labels.

## Hard Gates

The automation will not mark a sync as auto-merge-ready unless:

- The upstream merge completed cleanly.
- Checks passed or were explicitly skipped.
- Codex review approved the merge, or review was explicitly skipped.

If checks fail, merge conflicts appear, or Codex review is missing/risky, the result stays `needs-human-review`.

## GitHub Workflow

`.github/workflows/tritonai-upstream-sync.yml` is scheduled and manually dispatchable. It expects a self-hosted runner because the fork may need local Codex/TritonAI configuration. The workflow can push a sync branch and open a PR; auto-merge defaults off and should only be enabled after manual sync runs are predictable.

## Parent Release Sync

`scripts/tritonai-release-sync.mjs` is adapted from the T3Code fork's release sync helper. It finds the latest stable GitHub release from `pingdotgg/t3code`, merges that tag into the configured TritonAI Harness downstream branch, runs `TRITONAI_RELEASE_SYNC_CHECKS`, and can push/open a review PR.

The default downstream branch in this repo is `main`. Override it with:

```sh
export TRITONAI_RELEASE_SYNC_DOWNSTREAM_BRANCH=main
```
