# Getting started with TritonAI Harness

TritonAI Harness opens the workspace directly and skips the Connect, Agents, and Projects setup wizard. New desktop installations use the TritonAI workspace and starter conversation.

Use TritonAI Installer to install or repair the managed runtime. Update access in **Settings → Runtime** when credentials need attention.

To connect another computer, use **Settings → Connections**. Browser and mobile clients still need to authenticate or pair with a running Harness environment.

Add projects when you need them using **Add Project** in the command palette. Existing links to `/welcome` return to the workspace.

## Guided tour (experimental)

The guided tour is a short walkthrough for people new to AI. It is off by default. To try it, turn on **Settings → General → Experimental → Guided tour**, then choose **Start tour**. It works in the desktop app and in a browser connected to a TritonAI server.

You pick the kind of work you do and one real task to try first. A file task can use a sample, which is pasted into your message, or one of your own files. An email, calendar, or Teams task first connects Outlook or Gmail; the Connect step lists what that sign-in lets TritonAI read. The task runs in a new Supervised conversation in your TritonAI folder, so saving a file or changing anything in a connected account asks you first. Follow-up suggestions appear above the message box until you hide them.

Choose **Exit tour** to leave at any step; **Start tour** always begins again from the start. Turning the experiment off removes the tour and its suggestions; conversations it started stay in the sidebar.
