# Memory

Memory keeps a daily summary of your threads in a folder of Markdown notes, and lets Codex agents look back through it when earlier work matters.

Memory is on by default for new and existing installations, including Nightly. When you install an update that adds Memory, it starts automatically unless you have explicitly turned it off. The switch is under **Settings > General > Memory**. Each machine keeps its own memory, so the setting appears when one environment is selected.

## What it writes

Memory lives in a `memory` folder inside the TritonAI Harness home directory, such as `~/.tritonai-harness/memory` or `~/.tritonai-harness-nightly/memory`. The `general` folder inside it holds:

- `Daily/`: one note per day with the work done, decisions, open loops, and the threads involved. Each thread lists its Codex session file, so an agent can open the full conversation.
- `Projects/`: one note per project. Write your own notes under **Pinned**. Memory only adds a dated line under **Recent**.
- `Inbox/`: notes written during the day. The next daily note includes them and moves them to `Inbox/processed/`.

The notes use Obsidian links, so you can open the `general` folder as an Obsidian vault. Any editor works too. **Open folder** in settings opens it in your preferred editor.

## When notes are written

On its first run, Memory automatically creates the folders and backfills the previous seven completed days from your saved Harness conversations. A fresh installation with no saved conversations creates the folders and begins collecting memory as you work.

A day's note is written after the day ends, in the background, while TritonAI Harness is open. Memory checks when the app starts and once an hour. If the app was closed, it catches up on the finished days it missed, up to the last seven. Days without thread activity get no note. Settings shows the last day Memory has caught up through. Between the first day Memory summarized and that day, a missing note means there was no activity. Days after it, and days Memory never covered, may have work that is not in the notes yet.

The summary uses your text generation model under **Settings > General > Text generation**, which must be a Codex model. If a summary fails, settings shows the error and Memory retries that day at the next check.

## How agents use it

When Memory is on, Codex agents get a `tritonai-memory-…` skill that points to the folder. Each vault has its own skill, so Stable and Nightly can share a Codex home without overwriting or removing each other's memory skill. They read it when you ask about earlier work, and they only write to it when you ask them to remember something or close out work. Agent notes go to `Inbox/`.

Turning Memory off stops new notes and removes the skill. Your notes stay in the folder.
