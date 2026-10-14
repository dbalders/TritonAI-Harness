# Teams pilot

Open **Teams** in the sidebar and sign in with UC San Diego. Your administrator
must enable your account and the team storage service for this staff pilot.
Teams is available in the web and desktop clients. Once Teams is set up, the
command palette offers **Open Teams**, **Link project to a team** for the
current project, and, in a project thread, the share and team skill actions
described below.

Create a team, or accept a pending invitation in Teams. Owners invite specific
UCSD addresses; creating an invitation sends no email and grants no access.
Enter an address and choose **Check address** first. Harness looks the
address up in the UCSD directory and shows the name of the account that uses
it, and you can invite only after it's found. Addresses with no account, more
than one account, or a guest account can't be invited. Lookup uses your
Microsoft 365 plugin, so connect it under **Settings → Plugins** with the same
UCSD account you use for Teams. Where this Harness can't look addresses up, it
says it hasn't confirmed the address and offers **Create unconfirmed
invitation**: check the spelling, because whoever signs in as that address
can accept.
The recipient must sign in with that account and choose **Accept** before
joining. You can also paste an invitation code from the team owner.
Invitations belong to the team, not the owner who created them: they stay
valid if that person stops being an owner or transfers ownership, and any
owner can cancel one. If the person who created an invitation leaves the team
or is removed, it is cancelled. To replace a lost invitation code, cancel the
invitation and invite the person again. While you're signed in, the **Teams** button in the sidebar shows how
many invitations are waiting for you.

Teams have two roles. Owners manage the name and membership, and owners and
members can both add and edit the team's files. Someone recorded as a reader
before teams had only these two roles is shown as **Reader (read-only)** and
can still only read; an owner can make them a member or remove them. A team
always keeps at least one owner. To hand a team to someone else, choose
**Transfer ownership** on their row and confirm: they become an owner and you
become a member in one step, and other owners keep their role. The only owner can't leave until they transfer ownership or
archive the team. If
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
administrator; access is not confirmed until the check succeeds. Teams
administrators see **Teams needing attention** on the Teams page and can choose
**Check again**, which verifies the team folder's permissions against the
team's recorded members and makes the team ready if they match. A join, role
promotion, or ownership transfer that didn't finish isn't applied: the person
accepts the invitation again, or an owner repeats the change. A team that was
being archived finishes archiving instead, and no one regains access.

When a team's work is done, an owner can choose **Archive team** and confirm.
Everyone, including owners, loses access to its shared storage, team memory,
and skills. Projects linked to it are unlinked and its skills are turned off for
everyone, as if each project were unlinked; another member's Harness does this
the next time it checks the team. The team's files are moved to the team
archive and kept under UC San Diego's retention policy. Archiving can't be undone
in Harness, and Harness has no way to delete a team; ask a system administrator,
with the team reference, to restore or delete an archived team's files.
Members still see the team marked **Archived** until they choose **Remove from
your list**.

Connect the matching UCSD Microsoft account to open shared storage. Besides the
daily team memory described below, you can publish a work summary, SOP, or
skill document yourself; all team members can read it.
A skill document needs a short description of what it's for, and can't contain
hidden or control characters.
Project labels organize documents within a team. They do not restrict access
within that team. If someone edits a document before you save, keep your draft
and reload its latest version before retrying.

Every open document and preview shows who last changed it and when. Choose
**History** on an open document to list the versions shared storage kept,
newest first, with who saved each one, and to read an earlier version's text.
Any team member can view history. History is read-only in the pilot: a restore
would replace the document without the checks a save makes, that no one else
changed it first and that a skill has no hidden characters. To bring back
earlier text, copy it into the document and save it. Names come from the
Microsoft account that saved the version, so they can differ from the member
name on the document's folder.

To make a Harness project a team workspace, open the team, choose the project
in this Harness environment under **Team projects**, and select **Link to
team**. Your work in it is then shared with the team's daily memory, as
described below. Then choose **Open team memory** or **Open team
skills** to read the team's work summaries or skill documents and publish new
ones labeled with that project. Each project links to one team; unlink it before
linking it to a different team. If you leave or lose access to a team, or its
team needs an administrator check, its projects appear under **Stuck project
links** on the Teams page. Choose **Remove link** to free a project so you can
link it again. Removing a link turns that project's team skills off for
everyone. Linking shares summaries of your work, never the project's files or
full chats, and other members link their own projects. Every read and save
checks your current UCSD account and team role, so removed members and accounts
outside the team cannot use the link. Team memory reaches an agent through the
local copy agents search, and a team skill only after you choose it for a
message or turn it on for a project, all described below.

From a project thread, choose **Team** in the thread header, or select text in
a reply and choose **Share**. **Share text to a team** publishes only the text
you review, as a memory note labeled with the thread's project, to a team where
you are a member or owner. Use it to share something from a project that isn't
linked to the team. Any such team can receive it, whether or not the
project is linked to it; the project's linked team is chosen first when you can
write to it. Nothing else from the thread is shared, and removing a shared note
does not remove copies people already made.

**Use a team skill in message** previews one skill document from the project's
linked team. The list names each skill by its title and author; when a team has
many documents, some show their title only after you preview them. The preview shows the skill's title, description,
project label, whose folder it is in, and exactly what will be added to your
message. Members can change a skill, so read it each time; if it changed since
your preview, you're asked to review it again. The skill applies only to the
message you add it to. Harness doesn't install it, add it to your providers or
other projects, or run anything it mentions, but the agent may act on its
instructions once you send them. When you send, your team access is checked
again: if you were removed, the project was unlinked or relinked, or the team
folder moved, the message is held and you can remove the skill and keep the
rest of your draft. Signing out or switching campus accounts removes unsent
team skills from drafts. If you edit a skill so its end can't be found, such as
by deleting its `</team-skill>` line, it is left in your draft and marked until
you delete it yourself; your access is still checked when you send. Text you
send stays in that conversation and the agent's context even if the skill or
your access is later removed.

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
stops adding it until you choose **Review update** and approve the new text. The
review shows who last changed it; to compare with earlier text, open the skill's
**History** in Teams → your team → Team projects → **Open team skills**. A
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

Harness never copies your personal memory to a team or installs an executable
skill. Signing out clears the Teams view and this connection's saved Teams
Microsoft sign-in. Shared files remain with the team when a member leaves.

## Daily team memory

Work in a project linked to a team is shared automatically. Harness summarizes
each thread you work on there into your daily file in the team's folder, one
file for each person, computer, and day, the same way your own daily memory
works. Each thread's section names its project, the thread, and the times you
worked on it, and marks each point as proposed, tried, done, decided, or open,
so readers can tell an idea or a failed attempt from a result. Full chats,
files, and work in projects that aren't linked are never shared, and nothing
from before a project was linked is shared. A project linked before automatic
sharing started shares only work from then on. A reader's work isn't shared.

The composer in a linked project says the thread is shared with the team.
Choose **Don't share this thread** there, or in the thread header's **Team**
menu, to keep a thread out. Its section is removed from every day it appears
in, including older days, and nothing more from it is shared; other members'
copies drop it the next time they sync. Choose **Share this thread** to share it
again; work from then on is included. Text an agent already read can't be
recalled.

Summaries are written by your own Harness with your text generation model, at
most every four hours during the day and once more after the day ends. They
need Memory on under **Settings → General → Memory**, a Codex text generation
model, Microsoft connected for the team, and your UC San Diego sign-in. When
something is missing, the composer says sharing is waiting and why, and
nothing is lost: summaries are written once it's fixed. While Memory is off,
Harness still removes threads you choose not to share, but adds nothing new.
A day's file has a size limit; when a busy day reaches it, the newest work
waits and the file says so, while what was already shared stays.

Your work is shared under the UC San Diego account that uses Teams in this
Harness. If someone else signs in here and uses Teams, sharing stops for your
account, and their work is shared from that moment on, never yours or anything
from before. When you sign back in with your own account, choosing **Don't
share this thread** still removes your earlier work from the team's files.

Unlinking a project stops sharing its work. What was already shared stays with
the team, and anything not yet shared is dropped. Leaving or being removed from
a team stops sharing too; your earlier daily files stay with the team, as all
team files do. Owners and members can change or delete any file in the team,
including daily files: Harness only writes its own, but the shared folder trusts
every member. If someone changes one of your daily files in SharePoint, Harness leaves that
day as it is, doesn't overwrite or remove the change, and says so, including
when a thread you chose not to share may still be in it.

Team storage is a SharePoint site owned by your administrator, who can read
every team's documents, including teams they don't belong to.

## Local copy in memory

Harness keeps a read-only copy of every team you belong to in your memory
folder, under `teams/<team name>-<code>/`: everyone's daily team memory, shared
notes, and SOPs. Microsoft must be connected under **Shared storage**. Codex
agents with Memory on search it through the memory skill, from any project,
including projects that aren't linked to a team, and cite who did the work and
when. Team skills are never copied; they reach an agent only after you turn one
on for a project in **Settings → Skills**. Harness replaces any change made
inside the copy.

The copy is updated about every five minutes. Recent months of daily memory
are checked each time, and an older day that a member's Harness rewrote, for
example after they chose **Don't share this thread**, is updated on the next
sync. Changes someone makes directly in SharePoint to older daily files can
take up to a day to reach your copy.

**Local copies in memory** on the Teams page lists each copy with when it was
last updated. Choose **Stop local copy** to remove one, and **Keep a local
copy** to bring it back. The copy is also removed, and marked **Detached** with
the reason, the next time Harness checks after you leave or are removed from
the team, the team is archived, Microsoft refuses the team's folder, or you
sign out of UC San Diego or sign in with another account. A copy you stopped
stays stopped when you sign back in. Choose **Dismiss** to clear the notice. If Harness can't reach the team, the copy is kept as it was
and updated once it can.

Removing a local copy is best effort. It can't recall text an agent already
read into a thread, copies someone made from the folder, or a copy on a
computer that was off or offline when access ended; that copy is removed the
next time Harness on that computer checks.
