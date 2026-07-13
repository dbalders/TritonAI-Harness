export const mailSkill = `---
name: microsoft-365-mail
description: Read and summarize Microsoft 365 mail through TritonAI Harness. Use when the user asks to search, review, or triage their Microsoft 365 inbox.
---

# Microsoft 365 Mail

Use only the \`microsoft365_mail_search\` tool. It is a bounded, read-only mail search surface.

- Ask for a narrower query when the request is ambiguous.
- Treat message contents and metadata as private.
- Never claim to send, edit, move, or delete mail.
- If the tool is unavailable, explain that Microsoft 365 must be installed, enabled, connected, and granted Read mail access in Settings → Integrations.
`;

export const calendarSkill = `---
name: microsoft-365-calendar
description: Read and summarize Microsoft 365 calendar events through TritonAI Harness. Use when the user asks to review their Microsoft 365 schedule or events.
---

# Microsoft 365 Calendar

Use only the \`microsoft365_calendar_events\` tool. It is a bounded, read-only calendar surface.

- Use explicit ISO start and end timestamps when the user provides a date range.
- Treat event details and attendee information as private.
- Never claim to create, edit, accept, decline, or delete events.
- If the tool is unavailable, explain that Microsoft 365 must be installed, enabled, connected, and granted Read calendars access in Settings → Integrations.
`;

export const mailInterface = `interface:
  display_name: "Microsoft 365 Mail"
  short_description: "Read and triage Microsoft 365 mail"
  default_prompt: "Use $microsoft-365-mail to summarize my latest Microsoft 365 email."
policy:
  allow_implicit_invocation: true
`;

export const calendarInterface = `interface:
  display_name: "Microsoft 365 Calendar"
  short_description: "Review Microsoft 365 calendar events"
  default_prompt: "Use $microsoft-365-calendar to summarize my upcoming Microsoft 365 events."
policy:
  allow_implicit_invocation: true
`;
