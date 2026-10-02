# Memory

Memory keeps a daily summary of your threads in a folder of Markdown notes, and lets Codex agents look back through it when earlier work matters.

Memory is on by default for new and existing installations, including Nightly. When you install an update that adds Memory, it starts automatically unless you have explicitly turned it off. The switch is under **Settings > General > Memory**. Each machine keeps its own memory, so the setting appears when one environment is selected.

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

To see every computer's notes on each of them, turn on **Sync memory with OneDrive** under **Settings > General > Memory**. If the Microsoft 365 plugin is already connected, sync starts right away. Otherwise Memory shows a code to enter at Microsoft's sign-in page with your UC San Diego account.

Your notes stay in the same local folder. Memory copies them to `TritonAI Harness/memory/general` in your OneDrive (Nightly uses `TritonAI Harness Nightly`) and brings in your other computers' notes about every five minutes. Each computer only changes its own notes, so they never overwrite each other. The `Notes` folder syncs both ways; if you edit the same note on two computers before they sync, you keep both versions, one with "conflict" and the computer's name in its title.

Sync never deletes your notes to match another computer. If this computer loses its memory folder, sync downloads its notes again from OneDrive. **Sign out** stops sync and forgets the Microsoft sign-in; the notes stay on this computer and in OneDrive.

## How agents use it

When Memory is on, Codex agents get a `tritonai-memory-…` skill that points to the folder. Each vault has its own skill, so Stable and Nightly can share a Codex home without overwriting or removing each other's memory skill. Agents read the notes when you ask about earlier work, and they only write to memory when you ask them to remember something or close out work. Agent notes go to this computer's inbox folder.

Turning Memory off stops new notes and removes the skill. Your notes stay in the folder.
