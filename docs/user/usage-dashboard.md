# Usage dashboard

Open **Settings** → **Usage** to see separate full-width live quota snapshots for TritonAI on-prem and cloud model access. Each card shows the key alias, current spend, budget limit, remaining budget, utilization, and reset time reported by TritonAI.

The dashboard reads `LITELLM_CLOUD_API_KEY` for cloud usage and `LITELLM_ONPREM_ADMIN_KEY` for on-prem usage. Both requests run on the connected Harness server. Credentials are never included in the WebSocket response or sent to the client.

The cards refresh independently every five minutes. If one credential is missing, rejected, or temporarily unavailable, the other card can still load. **Refresh** retries both snapshots, and a card with previously loaded data keeps its last successful snapshot visible when a later refresh fails.

The dashboard is a current quota view, not an itemized usage history. Low-budget notifications continue to follow the server's current `TRITONAI_API_KEY`; the two-card dashboard is the place to compare both managed key pools.
