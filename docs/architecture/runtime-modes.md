# Runtime modes

T3 Code has a global runtime mode switch in the chat toolbar:

- **Full access** (default): for Codex, starts sessions with `approvalPolicy: never` and
  `sandboxMode: danger-full-access`. Commands, edits, dynamic tools, and plugin tools run without
  approval prompts.
- **Auto-accept edits**: accepts workspace edits while asking before other actions, including
  write-capable dynamic and plugin tools.
- **Supervised**: for Codex, starts sessions with `approvalPolicy: untrusted` and
  `sandboxMode: read-only`. A limited allowlist of safe read-only commands may run in that sandbox
  without a separate approval. Commands needing additional permissions, file-changing operations,
  and write-capable dynamic and plugin tools prompt in-app.

Other providers map these modes onto their own permission controls, so command-level behavior may
differ.

Runtime mode controls task approvals. Plugin enablement, selected capabilities, provider connection
state, tool allowlisting, credential scopes, and remote-service authorization remain independent
availability boundaries in every mode.
