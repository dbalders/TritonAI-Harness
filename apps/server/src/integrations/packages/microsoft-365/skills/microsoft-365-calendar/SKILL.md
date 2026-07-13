---
name: microsoft-365-calendar
description: Read and summarize Microsoft 365 calendar events through TritonAI Harness. Use when the user asks to review their Microsoft 365 schedule or events.
---

# Microsoft 365 Calendar

Use only the `microsoft365_calendar_events` tool. It is a bounded, read-only calendar surface.

- Use explicit ISO start and end timestamps when the user provides a date range.
- Treat event details and attendee information as private.
- Never claim to create, edit, accept, decline, or delete events.
- If the tool is unavailable, explain that Microsoft 365 must be installed, enabled, connected, and granted Read calendars access in Settings → Integrations.
