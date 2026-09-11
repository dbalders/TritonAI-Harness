# Computer use

TritonAI Harness packages [Cua Driver](https://github.com/trycua/cua) as its local computer-use runtime. A separate Codex or ChatGPT desktop installation is not required, and TritonAI does not read or modify the user's normal `~/.codex` configuration.

Computer use is off by default. In the desktop app, open **Settings > General** and turn on **Computer use** to opt in. Turning it off again removes the computer-use tools after TritonAI Harness restarts.

On macOS, turning the setting on requests Accessibility and Screen Recording access. Settings shows each grant separately and distinguishes **Off**, **Needs permissions**, **Restart required**, and **Ready**. If System Settings opens, enable TritonAI Harness, return to the app, and choose **Restart Harness**. Use **Request permissions** to retry onboarding or **Check again** to refresh the status. While setup is waiting for permissions, the visible panel checks automatically every second and immediately when you return to the window. Checks stop when the grants are ready or the panel is closed or hidden. If System Settings already shows access allowed but Harness still reports it missing, quit and reopen the same copy of Harness. The driver does not start until both grants are present. Windows and Linux do not use the macOS permission flow. TritonAI Harness does not request these permissions while computer use is off.

When available, the Codex agent can inspect apps and windows, capture the desktop, use accessibility elements, click, type, scroll, drag, press shortcuts, and show a session-owned agent cursor. It is instructed to observe before acting, verify meaningful actions, and honor permission or approval failures.

Computer use is available only to the local desktop backend. WSL, SSH, and other remote backends intentionally do not receive the host computer-use connection.

Computer use currently works with the Codex provider. Claude, Cursor, Grok, and OpenCode sessions do not receive the computer-use tools in this release.

Release builds bundle a reviewed driver version and disable the driver's own telemetry and update checks.

## Starting computer use

Ask in plain language, for example: “Use computer use to open Notes and create a note.” You can also choose **/computer-use** in the chat command menu and add the task after it. Computer use is a built-in capability; it is not a `$` skill.

In desktop chat, `/computer-use` and messages starting with “Use computer use” check readiness before sending. If access is missing, a card explains what is needed and opens Computer use settings; your draft stays in place. Sending `/computer-use` by itself checks readiness and explains how to add a task. Other phrasings can also invoke computer use through the agent, which receives the desktop status recorded when its backend started.

Computer-use calls appear as distinct activity cards showing the action, session name when available, and progress or failure status. Expand a card to inspect its tool details. The agent is instructed to explain permission failures and use the desktop tools when you request computer use.
