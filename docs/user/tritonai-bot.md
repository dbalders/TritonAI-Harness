# TritonAI Bot

TritonAI Bot is an optional personal assistant that runs as a separate cloud
service. It is a personal pilot, not an official campus service. Anyone with a
UC San Diego account can sign in and get their own private bot: an ongoing
conversation, private memory and reminders, and approvals for anything it wants
to do on your behalf.

Open **TritonAI Bot** in the sidebar and choose **Sign in with UC San Diego**.
On desktop, your browser opens campus sign-in and then returns you to Harness
automatically. In a web browser, sign in and confirm the code shown in Harness.
The mobile app does not support TritonAI Bot yet.

While a message is pending, a short status underneath it shows the bot's current
activity when the service supplies a recent update. After 90 seconds without an
activity update, it changes to **Status unavailable**, including when the
connection drops. **Needs your input** means the run is waiting for your approval;
it remains visible even when worker activity updates stop. These statuses do not
show the bot's reasoning or action details.

The bot appears in the sidebar only when a service address is set. If your build
does not include a default address, add one in Settings. To use a different service
or turn the bot off, open
**Settings → Connections → TritonAI Bot**. Changing or clearing the address signs
you out of the previous service; your bot session is never sent to another address.

Outlook, calendar, OneDrive and To Do access is limited to the pilot account. For
other accounts the bot says so and keeps chatting, remembering and reminding.
If the service is not accepting new users, sign-in tells you so; existing users
can still sign in. The service also has daily usage limits per person and for
all users together, and replies when a limit is reached.

When your bot service supports it, the **Handling** panel shows work needing
your attention, work in progress, upcoming items and recent results. Stop ends
one item after confirmation. A stop request cannot recall an assignment already
running in Harness or undo an action sent to another service. Pause keeps your
saved work and blocks new execution until you resume.

Open **Watches & routines** to check monitoring freshness and manage scheduled
prompts. Run now requests a run; its result arrives separately. Stop deletes a
saved routine while keeping past results. Watches show their supported Teams
commands. **What I can do** explains which features your account can use and
which need a connection. Mark recent Handling results seen after reviewing them.
For routines, mark results read after reading them in your conversation to reset
the unread spending limit; a paused routine still needs Resume. If Microsoft access expires, **Reconnect Microsoft**
opens the existing connections page.

This sign-in is separate from your [UC San Diego account](./ucsd-account.md)
connection to a Harness environment.
