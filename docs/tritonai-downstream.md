# TritonAI Harness Downstream Operations

TritonAI Harness is the UCSD-oriented downstream of upstream T3 Code. The downstream should stay Codex-first: runtime work should assume `codex app-server` is invoked ad hoc, with TritonAI-specific provider/model configuration passed explicitly by the Harness process.

## Branch Structure

- `upstream/main`: upstream source from `https://github.com/pingdotgg/t3code.git`.
- `vendor/t3code-main`: fork mirror branch when a clean upstream mirror is useful.
- `main`: active TritonAI Harness downstream branch.
- `sync/upstream-*`: generated branches from upstream sync attempts.

Use project-specific branch names. Do not create tool-owned branch prefixes such as `codex/...`.

## Local Upstream Sync

The sync script creates a temporary git worktree so the normal checkout can stay dirty while the merge is evaluated elsewhere.

Dry orientation run:

```sh
bun run tritonai:sync:check
```

Review run with the configured Codex command:

```sh
export TRITONAI_SYNC_AGENT_COMMAND='codex exec "$(cat "$TRITONAI_SYNC_AGENT_PROMPT_FILE")" > "$TRITONAI_SYNC_AGENT_RESPONSE_FILE"'
bun run tritonai:sync:review
```

Push a generated sync branch and open a PR:

```sh
bun run tritonai:sync:pr
```

The script exits with:

- `0`: already current, auto-merge-ready, or allowed needs-review result.
- `2`: human review needed.
- `1`: script, git, or environment failure.

Useful environment overrides:

- `TRITONAI_SYNC_DOWNSTREAM_BRANCH=main`
- `TRITONAI_SYNC_UPSTREAM_REMOTE=upstream`
- `TRITONAI_SYNC_UPSTREAM_URL=https://github.com/pingdotgg/t3code.git`
- `TRITONAI_SYNC_UPSTREAM_BRANCH=main`
- `TRITONAI_SYNC_CHECKS="bun run typecheck && bun run test"`
- `TRITONAI_SYNC_AGENT_SECRET_ENV_ALLOWLIST="CODEX_HOME,TRITONAI_HOME,TRITONAI_API_KEY"`

## Codex Review Command

The sync script owns git, branch publishing, PR creation, and optional PR merge. Codex should only review the temporary worktree and write a JSON decision to the response file.

Example:

```sh
export TRITONAI_SYNC_AGENT_COMMAND='codex exec "$(cat "$TRITONAI_SYNC_AGENT_PROMPT_FILE")" > "$TRITONAI_SYNC_AGENT_RESPONSE_FILE"'
```

The response must be JSON:

```json
{
  "auto_merge": false,
  "reason": "short reason",
  "summary": "what happened",
  "risks": ["risk or follow-up"]
}
```

For now, keep DeepSeek as the review model if your Codex config exposes it. Do not add non-Codex review commands or provider assumptions to this path.

## Release Control

Installer and updater changes should consume GitHub Release assets from the TritonAI fork only after the fork publishes compatible Electron assets:

- `latest-mac.yml`
- `latest.yml`
- macOS `.dmg`
- Windows `.exe`
- `.blockmap` files

Branches are for source integration. GitHub Releases are for installer and updater consumption.

To prepare a PR that merges the latest stable parent T3 Code release into TritonAI Harness:

```sh
bun run tritonai:release-sync:pr
```

Useful release-sync overrides:

- `TRITONAI_RELEASE_SYNC_DOWNSTREAM_BRANCH=main`
- `TRITONAI_RELEASE_SYNC_PARENT_REPO=pingdotgg/t3code`
- `TRITONAI_RELEASE_SYNC_CHECKS="vp check && vp run typecheck"`
