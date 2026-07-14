# Runtime modes

T3 Code has a runtime mode switch in the chat toolbar:

- **Supervised**: starts sessions with `approvalPolicy: untrusted` and `sandboxMode: read-only`, then prompts in-app for commands and file changes.
- **Auto-accept edits** (default): starts sessions with `approvalPolicy: on-request` and `sandboxMode: workspace-write`, allowing workspace edits while prompting for actions that need broader access.
- **Full access**: starts sessions with `approvalPolicy: never` and `sandboxMode: danger-full-access`.
