# Runtime modes

T3 Code has a global runtime mode switch in the chat toolbar:

- **Full access** (default): starts sessions with `approvalPolicy: never` and
  `sandboxMode: danger-full-access`. Commands, edits, dynamic tools, and plugin tools run without
  approval prompts.
- **Auto-accept edits**: accepts workspace edits while asking before other actions, including
  write-capable dynamic and plugin tools.
- **Supervised**: starts sessions with `approvalPolicy: on-request` and
  `sandboxMode: workspace-write`, then prompts in-app for commands, file changes, and write-capable
  dynamic and plugin tools.

Runtime mode controls task approvals. Plugin enablement, selected capabilities, provider connection
state, tool allowlisting, credential scopes, and remote-service authorization remain independent
availability boundaries in every mode.
