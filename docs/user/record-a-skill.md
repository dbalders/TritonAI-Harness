# Record a skill

Do a task once in other apps on your computer, then talk it through with an agent that turns it into a reusable skill. Recording is available in the desktop app, for apps on the same computer.

## Record a task

1. Type `/record-skill` in a conversation and press Enter, or choose **Record a skill** in the command palette. **Record a New Skill** at the top of **Settings → Skills** opens a new thread with `/record-skill` ready, so you can pick the project first. On macOS, Harness asks for Accessibility access the first time.
2. Switch to the app and do the task once. You can move between apps; Harness follows whichever app is in front, except Harness itself. A small recording bar stays on top with a timer.
3. Select **Stop** on the bar when you're done, or **Discard** to throw the recording away.

Recording lasts until you stop, for at most 10 minutes or 300 steps. Harness reads apps' accessibility events, such as which control had focus and what you selected or turned on. On a Mac it also notes what you click and keyboard shortcuts that use Command or Control. Text you type is not recorded, nothing is read from password fields, and nothing is saved or sent while you record.

## Turn it into a skill

When you stop, the recorded steps are sent right away to the conversation you started from, or to a new conversation in the same project when you started from a new thread. Labels and window titles can include private information, and everything you did in other apps while recording is included, so stop before switching to anything you don't want an agent to see.

The agent starts by walking you through the steps as it understands them. Tell it which to drop or change, what to call the skill, and what changes from run to run; once you confirm the steps, it writes the skill into your skills folder, and Codex skills then appear under **Your Skills**. Some apps expose little or nothing to accessibility, so the recording is a starting outline rather than an exact record.

Test the skill in an ordinary conversation before relying on it. To share it with UCSD, see [TritonAI Commons](tritonai-commons.md).
