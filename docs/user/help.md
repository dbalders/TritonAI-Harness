# Get help with TritonAI

Open **Help** in the web or desktop sidebar, or search for **Open Help** in the
command palette. Ask about settings, a provider that stopped responding, or a
plugin connection. You do not need to create a project first.

Help uses your environment's text generation model when you send a question.
Opening the page and preparing feedback do not run a model. The conversation
stays available while you navigate within the current app connection; restarting
the app clears it. Use **Clear conversation** to start over.

Each question includes a fresh snapshot of current settings, reported provider
and plugin state, and a summary of diagnostic failures. Help can distinguish
installed, enabled, connected, and available plugin capabilities. It also reads
preferences and computer-use readiness from the app you are asking in, and looks
up relevant instructions in the shipped user guides. Credentials and private
configuration contents are omitted; Help reports when information is unavailable.

Provider and plugin status comes from discovery and may need refreshing;
historical failures do not prove that a problem is still happening. App locations
belong to the environment's host, which may be a different computer from your
browser or phone. Help can explain how to change a setting, but cannot change
settings, connect plugins, or control your computer itself.

If Help cannot answer, use its recovery links to open provider, plugin,
connection, or diagnostic settings. These links and feedback preparation remain
available when the model is unavailable. The environment snapshot requires
diagnostic and orchestration read access; asking the model also requires
permission to run agents.

## Prepare feedback

Choose **Prepare feedback** and describe what happened, how to reproduce it,
and what you expected. Review the report before copying or downloading it.
The Help conversation is excluded unless you choose to include it. Raw logs,
configuration values, and other project conversations are not attached.

**Open issue tracker** opens the public TritonAI issue tracker. Paste the reviewed
report there and submit it when ready. Help does not send the report for you.
Common credential patterns are removed automatically, but review your own text
for private information before sharing it.
