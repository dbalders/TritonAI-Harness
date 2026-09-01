# Permission Modes

A permission mode controls how much the agent does on its own and when it stops to ask you.

The mode is set per thread, from the mode control in the message composer. Changing it in one
thread does not change any other thread. A thread created from inside another thread keeps that
thread's mode; otherwise new threads start in **Full access** unless you pick something else
before sending.

## The Modes

**Supervised**: where supported, safe read-only work may proceed without a prompt. Commands that
need additional permissions, file-changing operations, and write tools pause and wait for approval.
Exact command handling depends on the provider; work outside the workspace remains restricted.

**Auto-accept edits**: auto-approve edits, ask before other actions. File changes go through
without prompting; commands and anything else still stop for approval.

**Auto**: routine actions proceed without you; risky ones still ask. How this is enforced depends
on the provider: Codex delegates routine approvals to an AI reviewer, Claude uses its own auto
permission mode, and providers without an equivalent (such as OpenCode) fall back to asking, like
Supervised.

**Full access**: allow commands and edits without prompts. The default. The agent runs
unattended until it finishes or asks a question of its own.

Approvals appear inline in the conversation. Approve or reject one and the agent continues from
there.

For Grok, **Always allow this session** remembers the matching command or tool input. Other
actions still ask for approval. It does not change the thread to **Full access**.

## Choosing a Mode

Use **Full access** for work in a worktree or a sandbox you can throw away.

Use **Supervised** when you want commands needing additional permissions and file changes to wait
for approval, or the first time you run an unfamiliar task.

**Auto-accept edits** suits refactors where the edits are the point and you only care about the
shell commands.

## Provider Behavior

Each provider maps these modes onto its own approval and sandbox settings. For Codex,
**Supervised** uses the `untrusted` approval policy and a read-only sandbox. A limited allowlist of
safe read-only commands may run inside that sandbox without a separate approval; commands needing
additional permissions, file-changing operations, and write tools ask first. **Full access**
disables approval prompts and sandbox restrictions for Codex. Grok threads map **Supervised** to
ask mode even if the Grok CLI config is set to always-approve, and **Full access** to
always-approve. The labels above describe the shared boundary; the exact per-provider translation
is internal and may change.

Mobile offers the same four modes with the same labels and descriptions.
