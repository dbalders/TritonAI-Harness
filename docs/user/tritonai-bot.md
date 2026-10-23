# TritonAI Bot

TritonAI Bot is an optional personal assistant running as a separate cloud service.
It is a held Experimental candidate, not an official campus service. Availability
depends on your account and the service's current pilot access policy.

In **Settings → General → Experimental**, enable **TritonAI Bot**, then open it
from the sidebar and sign in with your own UC San Diego account. On desktop,
your browser opens campus sign-in and returns to Harness through a private local
callback. This pilot requires the desktop Harness for sign-in. Browser-only and
mobile sign-in are unavailable; no manual device-code fallback is offered.

The managed build supplies the service address. A custom service address can be
set in **Settings → Connections** if your administrator asks you to use one.
Changing services stops new tasks here and signs you out of the old service.
Clearing a custom address restores the managed default.
Enabling Bot does not grant Microsoft access, choose a model, or allow tasks to
run on this computer. Each requires its own consent or setting.

To disable Bot, turn off its Experimental switch while connected to your Harness.
This signs out and stops new assignments here. Running work and delivery of saved
results may finish. Your cloud bot and Microsoft permissions remain; use the bot's
pause control and Microsoft connections page to manage those separately.

Task permission belongs to the Harness, while the Experimental switch is separate
in each app or browser. A notice in the main window shows when tasks are allowed
while Bot is off or unavailable in this app, even with the sidebar hidden or
Experimental settings collapsed. This includes permission saved by an earlier
Nightly. Choose **Turn on Experimental Bot** to show Bot in this app without
changing the pairing. **Stop Bot tasks here** stops new assignments for every
client of this Harness; running work and saved result delivery can finish.

If Harness cannot read the saved task permission, the notice and Experimental row
say it cannot currently be checked and is retrying automatically. Permission is
unknown until that check succeeds. The check does not change task permission or
stop work already running.

## Chatting with your bot

TritonAI Bot is one ongoing conversation, shared with its Teams chat. Type a
message and press Enter to send it; Shift+Enter starts a new line. Send `/help`
to see what your account can use and what still needs connecting. Ask the bot to
remember or forget something, set a reminder, or check your calendar, email or
files.

While your message is being sent, **Sending your message…** appears above the
composer. While a reply is pending, a status in the conversation shows what the bot is
doing when the service supplies a recent update, or why it is waiting. After 90
seconds without an update it changes to **Status unavailable**. **Needs your
input** means the bot is waiting for your approval.

Bot replies can quote email, chat and file text that someone else wrote. Images
in a reply appear as links, and nothing in a reply loads on its own.

Use the paperclip to include up to three documents or screenshots in a message,
with a 4 MB limit per file. Supported files are TXT, Markdown, CSV, JSON, PDF,
Word DOCX, PNG, JPEG, and WebP. Wait for the upload to finish, then send. A
failed send keeps your files selected so you can retry. Stored files are
retained for 30 days.

Messages the bot sends on its own, such as alerts, briefings and routine
results, have Useful and Not useful buttons. Ratings record your judgment; they
don't change what the bot sends.

## Approvals, pause and connections

When the bot wants to act for you, an approval card appears in the conversation.
Open **Review action details** to see exactly what it will do, then choose
**Approve** or **Deny**. Approving an assignment that can no longer start is not
offered; deny it and ask for an updated one.

The pause button in the header holds new bot work and proactive messages until
you resume. It does not undo actions already started or recall work a task
computer already picked up. While paused, the conversation shows a **Resume**
button.

Connect your own Microsoft account to use Outlook, calendar, OneDrive and To Do.
The connection panel distinguishes missing consent, reconnect needs, temporary
problems and account restrictions. Each account uses its own Microsoft access.
If Microsoft access expires, the conversation shows **Reconnect Microsoft**. To
choose what the bot may use, open **Settings → TritonAI Bot → Microsoft
connections**. If the service is not accepting new users, sign-in tells you so;
existing users can still sign in. The service also has daily usage limits per
person and for all users together, and replies when a limit is reached.

The sign-out button in the header ends your chat session on this Harness. It does
not disconnect Microsoft or stop task running.

## Running assignments on a task computer

When your service supports task computers, open **Settings → TritonAI Bot** on
that computer, choose a project and select **Allow**. This authorizes that
Harness environment to run approved bot assignments as ordinary threads in the
selected project, using its model. Every Bot assignment runs in Auto mode. The bot can list the computer's registered projects and select one for each new assignment; this setting supplies the default. With **No project**, the
default, each assignment gets its own new folder, so the bot can start something
new without touching your existing projects. Every signed-in Harness
can chat and review approvals; only the computer you allow claims new
assignments. Allowing another computer moves new assignments there. Keep Harness
running for it to check in and collect work.

Ask the bot to create a thread for an audit, investigation, or other long-running
assignment. Independent assignments can run in parallel; **Parallel assignments**
sets how many new executions the computer starts at once. An assignment waiting
for approval or an answer leaves room for other work. Assignments that use the
same project folder take turns so they do not edit that folder simultaneously.

Ask the bot to continue a delegated assignment to post another message in the same thread and workspace. Older Bot threads switch to Auto when continued.

Ask what a delegated thread has done or why it is waiting. The bot can read its
recent visible messages, activity, approval state, and completed result, with the
time of the last report. These reports require the task computer to stay online;
an old report cannot confirm current progress. Open its thread from Bot settings
to answer a pending question or review a command approval.
Assignments already running when you update may return only their final result;
they do not prevent new independent assignments from starting.

Ask the bot to continue a particular assignment to send new instructions to that
same thread. A follow-up keeps the thread's workspace and permissions and waits
for its current turn to finish. Existing execution is not restarted. The
original task computer must still have the thread. These thread features require
a service and task computer that both support them.

**Stop running tasks here** stops new assignments on that environment. Work
already running may continue, and finished results are still delivered.

Results arrive in the conversation. A finished assignment is not proof that the
intended outcome is correct; review its result and any returned files before
relying on them. Generated files are uploaded for up to a day; a file that still
can't be returned is listed in the result with the output folder to collect it
from. On Windows, keep Harness's data folder on a local drive. If the result
itself can't be delivered, for example while the bot service is unreachable, the
task computer keeps it and keeps retrying. New work pauses if its retained
execution and delivery backlog reaches capacity. If the bot refuses the result, Settings shows a
notice and later assignments continue. The assignment is never run again. Open the
assignment's Harness thread to see its complete reply.

## Developer diagnostics

**Settings → TritonAI Bot → Developer → Show bot diagnostics** shows the bot's
records beside the chat for testing: the decision inbox, assignments, bot
memory, routines, file recipes and followed responsibilities. These panels are
off by default and the chat works without them. They may change between
versions.

This sign-in is separate from your [UC San Diego account](./ucsd-account.md)
connection to a Harness environment.
