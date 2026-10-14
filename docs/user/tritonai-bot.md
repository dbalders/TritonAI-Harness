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

When your bot service supports it, the **Decision inbox** brings together work
needing your attention, work in progress, upcoming items, and recent results.
Review opens the existing approval or result. Approve and Deny still control
whether an action may proceed. Stop ends one item after confirmation; it cannot
recall an assignment already running or undo an action sent to another service.
Pause keeps your saved work and blocks new execution until you resume. Older
services show the original Handling view and the controls they support.

Services that support it also say why each responsibility, file, assignment or
pending message is waiting: on you (a reply, a decision, a review, or resuming),
on your task computer (none chosen, offline, busy with another assignment, or
claimed with no result yet), on your Microsoft connection, or on the bot's own
retry. Each status shows the last update a record confirms and its actual next
check. When nothing is scheduled it says so, and a check whose time has passed is
marked overdue rather than shown as upcoming. A returned result is never shown as
verified; only your review completes a responsibility. If a status's own change
time passes while Harness can't reach the bot, it says it may be out of date.

Open **Watches & routines** to check monitoring freshness and manage scheduled
prompts. Create a routine from a recipe or your own instructions, choose its
schedule and timezone, and preview what it will ask the bot to produce. You can
edit the instructions before saving and choose whether to hear about every run
or only notable results. Connection notices explain when a recipe's sources
need access. Run now requests a run; its result arrives separately. Stop deletes
a saved routine while keeping past results. Mark results read after reviewing
them to reset the unread spending limit; a paused routine still needs Resume.
Watches show their supported Teams commands. **What I can do** explains which
features your account can use. If Microsoft access expires, **Reconnect Microsoft**
opens the existing connections page.

Use **File recipes** to turn each new file in one OneDrive folder into a Harness
assignment. Choose a folder with at most 100 items, such as a dedicated inbox,
then describe what to do with each file and the result you expect. Files already
in the folder never start. The bot checks about every 5 minutes, waits until a
new file stops changing, and sends its text to one assignment, with your
approval or, if you choose, your Harness task rule and the automatic review.
File text is treated as reference data, never as instructions. Each file shows
what was read and what happened: waiting, needs your decision, assigned,
skipped, or not started with a reason. Editing a file that already started does
not start it again. Pause, Stop, or editing the instructions keeps drafted work
from starting; work a Harness worker already picked up is not recalled. Files
that arrive while the recipe or your bot is paused, or while the folder is too
large to check, are listed but not started; use **Start** to run one. A recipe
holds at most 20 unfinished files at once. When it is full, newer files stay in
the folder, the recipe says how many are waiting, and they are picked up
automatically once you approve or decline waiting decisions. Pausing also frees
room, but then the waiting files are listed for you to start. A file the bot has
handled, or one that was there when you created the recipe, never starts again
on its own, even if it leaves the folder and comes back. If the bot can't
confirm whether a file's decision or assignment was created, it shows
**Checking what happened** and offers **Start** only after confirming that
nothing was created.

Use **Responsibilities** to follow a Harness task through an intended outcome.
Describe what must be true before it is done and the next step you expect. The
bot can observe the task and notify you when it needs attention. Review its
result against your criteria before marking the responsibility complete. Edit a
responsibility as work changes, or snooze it and resume following later.
Cancel closes the responsibility. These controls do not approve new actions or
cancel the underlying Harness task.

To keep a responsibility moving from your replies, choose **Continue from my
replies**, and optionally **Wait for** a named input such as a signed file. Then
reply in your bot conversation, or use **Reply in chat** to address one
responsibility directly. A reply that supplies the input, changes a requirement
or deadline, resolves a blocker, asks a question, or asks to stop continues it
once. Thanks or OK in that conversation starts nothing, unrelated messages get
an ordinary answer, and a reply never approves an action; approvals work as
before. A reply addressed to a responsibility that is cancelled, snoozed or has
replies off is not sent, so you can send it as ordinary chat instead. An
assignment drafted from earlier replies does not start after you change a
requirement or deadline, cancel, reopen, or turn replies off; a pending approval
for it can only be declined. Replies sent before you cancel or turn replies off
don't continue it after you reopen it or turn replies back on, so send a new
reply. A continuation already under way stops before its next step after any of
these changes. Work a Harness worker already picked up is not recalled. If a
message could fit more than one waiting responsibility, nothing changes until
you choose one with **Use that message here**, or `/use` and its number in
Teams. A responsibility stopped from a reply can be reopened.

Task results keep execution status separate from verification. Expand a task to
review its artifacts, source links, reported checks, and blockers. A finished run
is not proof that the intended outcome is correct. Downloadable files come from
the task computer; other artifacts and checks may be reported by the task agent.
Review them before relying on the result.

Generated task files can be returned automatically from macOS and Linux task
computers. Windows task computers return text results and support input attachments,
but generated file export is currently unavailable. The result lists this blocker;
retrieve those files from the output directory named in the Harness assignment.

Temporary file upload failures retry for up to 24 hours after the task computer
saves the completed result. This window continues during restarts and re-pairing.
If uploads still fail, the Bot returns the original result with a missing-files
blocker; retrieve those files from the output directory. The computer waits for
saved results to be delivered before claiming another assignment.

If your bot cannot accept a completed result, the task computer retains the full
receipt and evidence locally in encrypted recovery storage before trying a
text-only reply. This reply explains any missing structured evidence or shortened
text. Open the original task thread in Harness to review the complete reply.
If the text-only reply is also rejected, Settings shows a notice and later
assignments can continue. The saved recovery receipt survives restarts; the task
is not run again.

Choose **Attach files** to include up to three documents or screenshots in a
message, with a 4 MB limit per file. Supported files are TXT, Markdown, CSV, JSON,
PDF, Word DOCX, PNG, JPEG, and WebP. Wait for the upload to finish, then send your
message. You can remove a selected file before sending. A failed send keeps your
files selected so you can retry. Stored files are retained for 30 days.

Open **Bot memory** to inspect a saved fact, preference, or instruction and its
source. Edit a memory to correct its wording, then explicitly review the change
before saving. Forget removes it from the bot's memory while leaving past chat
messages intact. Useful and Not useful ratings record your judgment without
changing the bot's instructions. To make feedback a lasting preference, choose
**Save a preference…**, write what you want remembered, and review that wording.
These memories are private to your bot.

When your service supports task computers, open **Settings → TritonAI Bot** on
that computer, choose a project and select **Allow**. This authorizes that Harness
environment to run approved Bot assignments as ordinary threads in the chosen
project, using its model and permission defaults. Every signed-in Harness can
chat and review approvals; only the computer you allow claims new assignments.
Allowing another computer moves new assignments there. Keep Harness running for
it to check in and collect work.

**Stop running tasks here** stops new assignments on that environment. Work
already running may continue, and saved results are still delivered. Disconnect
signs out the chat session; use Stop separately to turn off task running. If a
follow-up begins before an assignment's outcome is collected, its result is
reported as unconfirmed. Inspect its Harness thread before asking it to run
again. Older services may not support task computers; failed setup does not
start an assignment.

This sign-in is separate from your [UC San Diego account](./ucsd-account.md)
connection to a Harness environment.
