# Memory

Memory keeps a daily summary of your threads in a folder of Markdown notes. Review project history and use Ideas or project next steps to bring earlier work into a new draft.

Memory is on by default for new and existing installations, including Nightly. When you install an update that adds Memory, it starts automatically unless you have explicitly turned it off. The setting is under **Settings > General > Memory**. Choose **All environments** to turn Memory on or off across connected computers, or select one environment to change it separately. **Mixed** means the connected computers have different settings. Offline computers keep their settings until you reconnect and apply the change.

## What it writes

Memory lives in a `memory` folder inside the TritonAI Harness home directory, such as `~/.tritonai-harness/memory` or `~/.tritonai-harness-nightly/memory`. The `general` folder inside it holds:

- `Daily/<year>/`: one note per day with the work done, decisions, open loops, and the threads involved. Each thread lists its Codex session file, so an agent can open the full conversation.
- `Projects/<project>/`: a note for each project with a line for every day it was worked on.
- `Inbox/<code>/`: notes agents wrote during the day. The next daily note includes them and moves them to `processed/`.
- `Notes/`: your own notes. Memory never changes them.

Every note Memory writes is named after the computer that wrote it, such as `Daily/2026/2026-09-29 MacBook Pro (3f2a).md`. The short code in parentheses tells two computers with the same name apart, and it is also the name of that computer's inbox folder. A folder that holds notes from more than one computer keeps each computer's notes separate.

Memory rewrites its notes, so keep your own writing in `Notes/`. If you edit a note Memory wrote, Memory saves your copy under `Notes/Recovered/` before it writes that note again.

The notes use Obsidian links, so you can open the `general` folder as an Obsidian vault. Any editor works too. **Open folder** in settings opens it in your preferred editor.

## When notes are written

On its first run, Memory automatically creates the folders and backfills the previous seven completed days from your saved Harness conversations. A fresh installation with no saved conversations creates the folders and begins collecting memory as you work.

Today's note appears a few hours into your day and is rewritten every four hours while there is new activity. It is marked as partial until the day ends. After midnight, Memory writes the finished day one last time. Memory works in the background while TritonAI Harness is open. It checks when the app starts and once an hour, and if the app was closed, it catches up on the finished days it missed, up to the last seven.

Days without thread activity or inbox notes get no note. Settings shows the last day Memory has caught up through. Between the first day Memory summarized and that day, a missing note means there was no activity. Days after it, and days Memory never covered, may have work that is not in the notes yet.

The summary uses your text generation model under **Settings > General > Text generation**, which must be a Codex model. If a summary fails, settings shows the error and Memory retries that day at the next check.

## Sync between your computers

To see every computer's notes on each of them, turn on **Sync memory with OneDrive** under **Settings > General > Memory**. If the Microsoft 365 plugin is already connected, sync starts right away. Otherwise Memory shows a code to enter at Microsoft's sign-in page with your UC San Diego account. You can turn sync on or off for all connected environments. Expand **Manage environments** for each computer's status, sign-in, sync, and folder actions. If you sign in for a remote computer, open Microsoft's page on your current computer and enter that remote computer's code; the remote environment receives and stores its own credentials. Pending sign-ins identify the computer they authorize. Sync pauses on computers where Memory is off.

Your notes stay in the same local folder. Memory copies them to `TritonAI Harness/memory/general` in your OneDrive (Nightly uses `TritonAI Harness Nightly`) and brings in your other computers' notes about every five minutes. Each computer only changes its own notes, so they never overwrite each other. The `Notes` folder syncs both ways; if you edit the same note on two computers before they sync, you keep both versions, one with "conflict" and the computer's name in its title.

If two computers have the same short code, sync stops with an ownership-conflict message to preserve your notes. Renaming a computer does not change its code. Keep sync off on the affected computers until their memory identities have been repaired; do not delete cloud notes or device records to clear the message.

A generated note is only deleted from OneDrive when sync has verified which computer uploaded it and that computer intentionally removed it. Notes from older sync records without that ownership evidence are restored if their local copy goes missing. If this computer loses its memory folder, sync downloads its notes again from OneDrive. **Sign out** stops sync and forgets the Microsoft sign-in; the notes stay on this computer and in OneDrive.

## How agents use it

Open a project to review its history and suggested next steps. A suggestion opens a draft for you to review before sending. Ideas can also use memory notes as background.

Agents no longer automatically search the note folder through a Memory skill. Old notes can contain text returned by connected services, so their reuse must retain the same access limits as their sources. Harness removes its previously generated Memory skill; your own skills and notes stay intact.

Turning Memory off stops new summaries. Existing notes stay in the folder, and **Open folder** remains available.
