# Teams pilot

Open **Teams** in the sidebar and sign in with UC San Diego. Your administrator
must enable your account and the team storage service for this staff pilot.
Teams is available in the web and desktop clients.

Create a team, or accept a pending invitation in Teams. Owners invite specific
UCSD addresses; creating an invitation sends no email and grants no access.
The recipient must sign in with that account and choose **Accept** before
joining. You can also paste an invitation code from the team owner.
Invitations belong to the team, not the owner who created them: they stay
valid if that person stops being an owner, and any owner can cancel one. To
replace a lost invitation code, cancel the invitation and invite the person
again.

Owners manage names and membership, editors can publish and edit documents,
and readers can view them. A team always keeps at least one owner. To hand a
team to someone else, choose **Transfer ownership** on their row and confirm:
they become an owner and you become an editor in one step, and other owners
keep their role. The only owner can't leave until they transfer ownership. If
an owner leaves UC San Diego, another owner can remove them; if they were the
only owner, give a system administrator the team reference so they can assign
a new owner. Your own row is marked **You**. Choosing a new role only stages
it: select **Review change** and confirm it. Transferring ownership, removing a
member, leaving, and cancelling an invitation also ask for confirmation, and
none of them can be undone in place: a removed member or someone who left needs a new
invitation, and if you give up the owner role, only another owner can restore
it. To remove yourself, use **Leave team**. If a confirmed change fails or
Teams doesn't answer, the change may still be in progress, so the dialog
offers **Refresh team** instead of a second try. Renaming preserves the team reference and its files. If a
membership change reports that permissions need checking, contact your
administrator; access is not confirmed until the check succeeds.

Connect the matching UCSD Microsoft account to open shared storage. Publish a
work summary, SOP, or skill document explicitly; all team members can read it.
A skill document needs a short description of what it's for, and can't contain
hidden or control characters.
Project labels organize documents within a team. They do not restrict access
within that team. If someone edits a document before you save, keep your draft
and reload its latest version before retrying.

To work with a team's memory and skills from a Harness project, open the team,
choose a project in this Harness environment under **Team projects**, and
select **Link to team**. Then choose **Open team memory** or **Open team
skills** to read the team's work summaries or skill documents and publish new
ones labeled with that project. Each project links to one team; unlink it before
linking it to a different team. Linking does not share the project's files or
chats, and other members link their own projects. Every read and save checks
your current UCSD account and team role, so removed members and accounts outside
the team cannot use the link. Team memory is never added to agent
conversations automatically; a team skill is added only after you turn it on
for a project, as described below.

From a project thread, choose **Team** in the thread header, or select text in
a reply and choose **Share**. **Share text to a team** publishes only the text
you review, as a memory note labeled with the thread's project, to a team where
you are an editor or owner; the project's linked team is chosen first when you
can write to it. **Add team memory to message** previews one note
from the project's linked team and adds it to your draft. The list names each
note by its title and author; when a team has many documents, some show their
title only after you preview them. When you send, your
team access is checked again: if you were removed, the project was
unlinked or relinked, or the team folder moved, the message is held and you can
remove the team memory and keep the rest of your draft. Signing out or switching
campus accounts removes unsent team memory from drafts. If you edit a note so
its end can't be found, such as by deleting its `</team-memory>` line, it is
left in your draft and marked until you delete it yourself; your access is
still checked when you send. Text you copy out of a note by hand is your own
text and is not tracked. Text you send stays in
that conversation and the agent's context even if the note or your access is
later removed; removing a shared note does not remove copies people already
made.

**Use a team skill in message** works the same way for skill documents from the
project's linked team. The preview shows the skill's title, description,
project label, whose folder it is in, and exactly what will be added to your
message. Editors can change a skill, so read it each time; if it changed since
your preview, you're asked to review it again. The skill applies only to the
message you add it to. Harness doesn't install it, add it to your providers or
other projects, or run anything it mentions, but the agent may act on its
instructions once you send them. Your access is checked again when you send,
and signing out removes it from unsent drafts, as with team memory.

To use a team skill in every message of a project, open **Settings → Skills**
and choose the project in **Applying settings for** at the top; without a
project chosen, **Team Skills** lists your linked projects. The linked team's
skills are listed with their author and description, and all start off. Turning
one on shows exactly what will be added to each message and its version; it is
on only for you, only in that project, and nothing is installed. Harness then
adds it after your text in each message you send in that project, checking your
UCSD account, team membership, and the project's link every time. The
composer shows which team skills are on and which are being held back.

A skill's version identifies its exact text. If anyone edits the skill, Harness
stops adding it until you choose **Review update** and approve the new text; a
skill that gains hidden characters or is removed from the team is also held
back. Up to five skills, together at most 32,000 characters, can be on for one
project. If you leave or are removed from the team, its skills are turned off
for you; unlinking the project turns them off for everyone. Skills you turned on
apply only while you're signed in with the same UCSD account, and only to
messages you send from Harness, not to slash commands, goals, scheduled tasks,
or agent tools. A device where Microsoft isn't connected for Teams sends your
messages without the team's skills. If Harness can't reach the team to check a
skill that's on, the message isn't sent until you try again or turn the skill
off. Settings → Skills still lists the skills you turned on for that project
then, with **Turn all off**.

Publishing never captures a conversation automatically, copies personal memory,
or installs an executable skill. Signing out clears the Teams view and this
connection's saved Teams Microsoft sign-in. Shared files remain with the team
when a member leaves.
