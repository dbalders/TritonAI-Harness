# TritonAI Sync Automation

This automation keeps the TritonAI Harness downstream branch close to upstream `pingdotgg/t3code` while preserving TritonAI branding, Codex-first runtime behavior, and UCSD provider/model constraints.

## Moving Parts

- `scripts/tritonai-sync-upstream.mjs`
- `.github/workflows/tritonai-upstream-sync.yml`
- `vp run tritonai:sync:check`
- `vp run tritonai:sync:review`
- `vp run tritonai:sync:pr`
- `vp run tritonai:sync:auto`
- `scripts/tritonai-release-sync.mjs`
- `vp run tritonai:release-sync:pr`

The upstream sync script creates generated `sync/upstream-*` branches in a temporary worktree. The parent release sync script uses generated `sync/release-*` branches so release PRs cannot overwrite ordinary upstream sync PRs.

## Review Modes

For a no-model dry check:

```sh
vp run tritonai:sync:check
```

For Codex review:

```sh
export TRITONAI_SYNC_AGENT_COMMAND='codex exec "$(cat "$TRITONAI_SYNC_AGENT_PROMPT_FILE")" > "$TRITONAI_SYNC_AGENT_RESPONSE_FILE"'
vp run tritonai:sync:review
```

For PR creation:

```sh
vp run tritonai:sync:pr
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

`.github/workflows/tritonai-upstream-sync.yml` is manual only (`workflow_dispatch`) and runs on hosted `ubuntu-latest`. It used to run daily on a self-hosted runner, but no runner was ever registered, so every scheduled run was cancelled. Upstream syncs are integration events that need a human on the PR, so a cron adds nothing. Dispatch it when upstream cuts a stable tag or when a specific upstream fix is needed. The workflow pushes a sync branch and opens a PR; auto-merge defaults off.

Without `TRITONAI_SYNC_AGENT_COMMAND` on the hosted runner the review phase reports `not-configured` and the PR is labelled for human review. That is the expected mode.

## Ancestry Rules

The sync script decides what to merge from git ancestry: `git merge-base upstream/main main`. That only works if every previous upstream integration is still an ancestor of `main`.

- **Never squash-merge a `sync/*` PR.** Squashing replaces the upstream commits with one new commit, so the next sync merges against a merge base from before the squash and reports every already-integrated upstream commit as a conflict. The script refuses to run when `TRITONAI_SYNC_PR_MERGE_METHOD` is `squash`, and every generated PR body repeats this rule.
- **Every sync PR report includes `mergeBase`, `mergeBaseDate`, and `upstreamCommitsToMerge`.** If the merge base date is older than the last integrated upstream tag, or the commit count is far larger than upstream's activity since that tag, ancestry has been broken and must be repaired before merging.
- **Repairing broken ancestry.** When an upstream tag's content has already been integrated by hand (or by a squash), record that fact with an empty merge commit on `main` so git agrees:

  ```sh
  git fetch upstream "+refs/tags/vX.Y.Z:refs/tags/upstream-vX.Y.Z"
  git merge -s ours --no-ff upstream-vX.Y.Z -m "chore(sync): record upstream vX.Y.Z as integrated"
  git diff HEAD~1 HEAD --stat   # must be empty
  ```

  `-s ours` changes no files. It only tells git that `main` already contains that tag. This was done for `v0.0.38` and `v0.0.42`, both of which had been squash-merged (#194, #272).

## Parent Release Sync

`scripts/tritonai-release-sync.mjs` is adapted from the T3Code fork's release sync helper. It finds the latest stable GitHub release from `pingdotgg/t3code`, merges that tag into the configured TritonAI Harness downstream branch, runs `TRITONAI_RELEASE_SYNC_CHECKS`, and can push/open a review PR.

The default downstream branch in this repo is `main`. Override it with:

```sh
export TRITONAI_RELEASE_SYNC_DOWNSTREAM_BRANCH=main
```
