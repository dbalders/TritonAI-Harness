---
name: microsoft-365-mail
description: Read and summarize Microsoft 365 mail through TritonAI Harness. Use when the user asks to search, review, or triage their Microsoft 365 inbox.
---

# Microsoft 365 Mail

Use only the `microsoft365_mail_search` tool. It is a bounded, read-only mail search surface.

- Ask for a narrower query when the request is ambiguous.
- Treat message contents and metadata as private.
- Never claim to send, edit, move, or delete mail.
- If the tool is unavailable, explain that Microsoft 365 must be installed, enabled, connected, and granted Read mail access in Settings → Integrations.
