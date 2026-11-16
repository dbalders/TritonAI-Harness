# Triage an issue

Triage lets your own coding agent investigate a TritonAI Harness problem. The agent
reads the logs and state of the machine, checks the TritonAI Harness source for that
version, finds known issues, and can help you write a good GitHub issue. It asks
before it applies a fix or posts anything.

## In the app

Open **Help** and choose **Diagnose a problem**, or open the command palette and
choose **Triage an issue**. A new thread with no project opens, with the triage
playbook linked in the message. Choose any
provider, describe what went wrong after the link, and send. TritonAI Harness gets the
source for the server's version while you write.

From Help, triage runs on the primary environment shown on the page. From the
command palette, it runs on the machine of the thread or draft that you have open. With
nothing open, it uses your primary machine if that supports triage, or else the
first connected machine that does. The new thread shows the machine name, and on
mobile the palette row shows it before you start. The agent runs inside that
Harness server, so it gives you any restart steps and does not do them itself.

## If triage cannot start

Open Help to prepare feedback with your environment snapshot and the error details.
If the app itself will not open, include the installed version and any startup
error when you contact support.
