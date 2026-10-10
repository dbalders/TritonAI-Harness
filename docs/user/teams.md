# Teams pilot

Open **Teams** in the sidebar and sign in with UC San Diego. Your administrator
must enable your account and the team storage service for this staff pilot.
Teams is available in the web and desktop clients. Once Teams is set up, the
command palette offers **Open Teams**, **Link project to a team** for the
current project, and, in a project thread, the share, team memory, and team
skill actions described below.

Create a team, or accept a pending invitation in Teams. Owners invite specific
UCSD addresses; creating an invitation sends no email and grants no access.
The recipient must sign in with that account and choose **Accept** before
joining. You can also paste an invitation code from the team owner.
Invitations belong to the team, not the owner who created them: they stay
valid if that person stops being an owner, and any owner can cancel one. To
replace a lost invitation code, cancel the invitation and invite the person
again. While you're signed in, the **Teams** button in the sidebar shows how
many invitations are waiting for you.

Owners manage names and membership, editors can publish and edit documents,
and readers can view them. A team always keeps at least one owner. To hand a
team to someone else, choose **Transfer ownership** on their row and confirm:
they become an owner and you become an editor in one step, and other owners
keep their role. The only owner can't leave until they transfer ownership or
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
team's recorded members and makes the team ready if they match. A join or role
promotion that didn't finish isn't applied: the person accepts the invitation
again, or an owner repeats the change.

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

Connect the matching UCSD Microsoft account to open shared storage. Publish a
work summary, SOP, or skill document explicitly; all team members can read it.
A skill document needs a short description of what it's for, and can't contain
hidden or control characters.
Project labels organize documents within a team. They do not restrict access
within that team. To find a document, type in the search box above a team's
documents, in Teams or in a thread's team memory and skill pickers. It matches
every word you type against each document's type, title, description, author,
and project label. Lists show these details for up to 100 documents; past that,
a document's title appears and becomes searchable once you preview it. Search
doesn't look inside document text. If someone edits a document before you save, keep your draft
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

To work with a team's memory and skills from a Harness project, open the team,
choose a project in this Harness environment under **Team projects**, and
select **Link to team**. Then choose **Open team memory** or **Open team
skills** to read the team's work summaries or skill documents and publish new
ones labeled with that project. Each project links to one team; unlink it before
linking it to a different team. If you leave or lose access to a team, or its
team needs an administrator check, its projects appear under **Stuck project
links** on the Teams page. Choose **Remove link** to free a project so you can
link it again. Removing a link turns that project's team skills off for
everyone. Linking does not share the project's files or
chats, and other members link their own projects. Every read and save checks
your current UCSD account and team role, so removed members and accounts outside
the team cannot use the link. Team memory reaches an agent only when you add a
note to a message or keep a local copy for agents to search, and a team skill
only after you turn it on for a project, both described below.

From a project thread, choose **Team** in the thread header, or select text in
a reply and choose **Share**. **Share text to a team** publishes only the text
you review, as a memory note labeled with the thread's project, to a team where
you are an editor or owner; the project's linked team is chosen first when you
can write to it. **Add team memory to message** previews one note
from the project's linked team and adds it to your draft. The list names each
note by its title, author, and project label, and you can search it. When you send, your
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

Publishing never captures a conversation automatically, copies personal memory,
or installs an executable skill. Signing out clears the Teams view and this
connection's saved Teams Microsoft sign-in. Shared files remain with the team
when a member leaves.

## Local copy in memory

To let agents look through a team's memory the way they look through your own,
open the team and choose **Keep a local copy** under **Team projects**. A
project in this environment must be linked to the team first, and Microsoft
must be connected under **Shared storage**. Harness then keeps a read-only copy
of the team's memory notes and SOPs in your memory folder, under
`teams/<team name>-<code>/`, and updates it about every five minutes. Codex
agents with Memory on find it through the memory skill. Team skills are never
copied; they reach an agent only after you turn one on for a project in
**Settings → Skills**. Harness replaces any change made inside the copy, so
publish from Teams to share something with the team.

**Local copies in memory** on the Teams page lists each copy with when it was
last updated. Choose **Stop local copy** to remove it. The copy is also removed,
and marked **Detached** with the reason, the next time Harness checks after you
leave or are removed from the team, the team is archived, Microsoft refuses the team's folder, the
team's folder changes, the last linked project in this environment is
unlinked, or you sign out of UC San Diego or sign in with another account.
Choose **Dismiss** to clear the notice. If Harness can't reach the team, the
copy is kept as it was and updated once it can.

Removing a local copy is best effort. It can't recall text an agent already
read into a thread, copies someone made from the folder, or a copy on a
computer that was off or offline when access ended; that copy is removed the
next time Harness on that computer checks. Copies are read-only: publishing to
the team is always something you do explicitly.
