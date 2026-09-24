# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Managed Models

GLM 5.3 Flash is the default on-prem model and supports text and image input. Choose Low, High
(the default), or Extra High reasoning. GLM 5.3 and Glimmer remain available. DeepSeek has been removed from the managed catalog; saved managed
DeepSeek selections fall back to GLM 5.3 Flash. Existing selections of other available models
are preserved.

## Engine Updates

Stable and Nightly can use the same Codex installation. If a new profile cannot find Codex,
Harness automatically looks for a working copy installed by TritonAI Installer. It also recovers
when an older Installer-managed executable is no longer available. Your custom executable choice
and profile settings are preserved.

If no working copy is available, the provider message asks you to install or repair Codex with
TritonAI Installer. Restart Harness after repairing the installation.

New Stable and Nightly profiles keep their Codex data separately. Existing profiles retain their
saved Codex home or historical default so older chats keep access to their history; an already
shared home stays shared.

The Codex engine installation remains shared. Updating it affects the apps that use that installation.

TritonAI Harness keeps Codex's planning tool enabled when starting the engine, including after
engine updates. You do not need to change your Codex configuration to keep planning available.

## Subagents

TritonAI models can delegate work to up to five subagents per parent thread. Open the
right panel and choose **Agents** to follow their status, activity, model, and token usage.
Stop interrupts the parent and its active children.

The limit applies to each parent thread, not the whole TritonAI service. Several simultaneous
threads still share your service's request limits, so reduce parallel work if you receive
“Too Many Requests.”

## Model Identity

Custom models added to the Codex catalog use a generic TritonAI Harness assistant identity.
Native Codex model entries retain their own instructions. When asked which model is
selected, the assistant uses the current turn's model information rather than guessing from
its training or earlier replies. This identifies the selected model, not independent proof
of which backend the provider served.

Older conversations can retain instructions that incorrectly identify the assistant as GPT-5.2.
After updating and restarting Harness, start a new conversation to use the corrected base instructions.

## Computer-Use Screenshots

TritonAI sends the four most recent images in each Codex request, including screenshots
returned by computer-use tools. Older images are replaced with text markers in the request
so extended sessions stay within the API's image limit. Conversation text and tool results
remain available, and the saved conversation keeps the original images. Ask the assistant
to capture the screen again if it needs to inspect an older state. Image attachments share
this four-image budget with screenshots.

## Attach Images To A Text-Only Model

When a managed model accepts only text, TritonAI analyzes attached images and passes their
descriptions and visible text to the model. If a group of images produces incomplete or malformed
analysis, TritonAI automatically retries each image separately before sending your message.

If an image still cannot be analyzed, the message stays unsent and the error identifies the failed
attachment. Stop cancels image analysis as well as the pending message.

## Work Toward A Persistent Goal

In a Codex thread, type `/goal` and choose the Goal command. The composer enters Goal mode, shows a
removable Goal chip, and prompts you to describe the objective. Enter the objective and send it:

```text
Finish the migration, preserve behavior, and pass the test suite
```

The goal rail above the composer shows the current objective, status, token use, elapsed time, and
last update. Codex can keep pursuing the objective across turns until the goal is paused, completed,
limited, stalled, or cleared.

You can also type raw commands without choosing the command-menu item:

```text
/goal                 Show the current goal
/goal pause           Pause it
/goal resume          Resume it
/goal clear           Clear it
/goal set <objective> Replace it, including objectives named pause, resume, or clear
```

Goal creation is currently available for Codex providers. Goals are text-only because Codex's native
goal API does not accept attachments or composer context cards.

## Use multiple accounts

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. TritonAI Harness prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. TritonAI Harness offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
