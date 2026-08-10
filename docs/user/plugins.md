# Managing hosted plugins

TritonAI Harness lists approved hosted plugins separately from the included plugins that ship with
the application. The hosted section currently exposes Lucid from the official Codex catalog.

## Enable and connect Lucid

1. Open **Settings** → **Plugins**.
2. Under **Approved hosted plugins**, turn **Lucid** on.
3. If **Action required: Connect Lucid** appears, choose **Finish sign-in** and complete the flow in
   the system browser.

Harness accepts the catalog-provided sign-in link only when it uses HTTPS on `chatgpt.com` and the
official Lucid app path. If the catalog returns another origin or path, Harness opens the known
official Lucid app page instead. Lucid and ChatGPT own the hosted runtime and authorization; Harness
does not receive the OAuth credentials.

The validated sign-in handoff remains available in the current browser tab after the Plugins screen
is reopened. If authorization was not completed, open it again. Harness keeps the action visible
until you return and choose **I've finished sign-in**; after that, **Connect or manage Lucid**
continues to open the same official app page.

## Disable Lucid

Turn **Lucid** off in **Settings** → **Plugins**. This uninstalls the selected Lucid catalog entry for
the managed Codex environment. You can turn it on again later.

If Lucid is unavailable or disabled, the ChatGPT workspace policy or remote-catalog authorization
may not permit it. Refresh the hosted-plugin section after correcting the account or policy issue.
