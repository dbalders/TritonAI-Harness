# Runtime modes

TritonAI Harness has a per-thread runtime mode switch in the chat toolbar:

- **Full access**: for Codex, starts sessions with `approvalPolicy: never` and
  `sandboxMode: danger-full-access`. Commands, edits, dynamic tools, and plugin tools run without
  approval prompts.
- **Auto-accept edits**: accepts workspace edits while asking before other actions, including
  write-capable dynamic and plugin tools.
- **Supervised** (default for new threads without a saved override or remembered composer choice): for Codex, starts sessions with `approvalPolicy: untrusted` and
  `sandboxMode: read-only`. A limited allowlist of safe read-only commands may run in that sandbox
  without a separate approval. Commands needing additional permissions, file-changing operations,
  and write-capable dynamic and plugin tools prompt in-app.

Other providers map these modes onto their own permission controls, so command-level behavior may
differ.

Defaults seed newly created drafts and threads. Existing web/desktop draft sessions retain their
stored starting mode across upgrades and settings changes. A pre-upgrade Full access draft
therefore keeps Full access until the user changes it. An explicit composer mode wins over
that seed. Retargeting a draft to another project or machine refreshes an implicit seed
from the remembered mode or destination defaults while preserving an explicit composer choice.

Runtime mode controls task approvals. Plugin enablement, selected capabilities, provider connection
state, tool allowlisting, credential scopes, and remote-service authorization remain independent
availability boundaries in every mode.
