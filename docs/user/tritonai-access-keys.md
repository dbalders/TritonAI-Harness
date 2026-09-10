# TritonAI access keys

Open **Settings → Runtime** and select your local on-prem or frontier connection.
The **Access key** status shows the last four characters of its configured key as
**Ends in abcd**, so you can identify it without revealing the full key.

Select **Change key**, enter the replacement, and choose **Check access & save**.
After access is verified, the local runtime restarts. Settings shows
**Updating access and reconnecting…** during this expected interruption, then returns
automatically with the new suffix. If reconnection takes too long, Settings confirms
your access settings were saved and continues trying to connect.
Reopen Runtime settings to confirm the key loaded by the runtime. Changing one
connection keeps the other connection’s key. Removing a key clears its suffix.
