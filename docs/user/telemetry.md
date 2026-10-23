# Product usage data

The TritonAI Harness server sends product usage events to TritonAI's Plausible analytics. Each event carries a random install ID so we can count how many installs use the app and how much, such as threads per install. The ID is created on first launch and stored as `anonymous-id` in the userdata directory. It is not derived from your name, accounts, or machine.

Events include the app version, operating system, which client is connected (desktop, web, or mobile), the provider, runtime and interaction modes, turn result, duration, and main-agent token totals when available. The server also reports thread and project counts and the month of your first thread.

Events do not include prompts, responses, file contents, file paths, project or thread names, model names, authentication tokens, provider account IDs, conversation IDs, raw provider events, or child-agent output.

Managed model requests also carry the app version, a purpose such as chat or voice, and the same random install ID to TritonAI's model gateway. This lets us compare model usage with product usage. The ID counts server installations, not people; clients connected to one server share an ID.

To disable product usage collection, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before starting it. No product events or optional gateway analytics tags or installation IDs are sent, and no install ID is created. The gateway's existing operational logging and budget accounting still apply to model requests.

To reset the install ID, quit TritonAI Harness and delete `anonymous-id` from the userdata directory. A new ID is created on the next launch. Events sent earlier are not erased.
