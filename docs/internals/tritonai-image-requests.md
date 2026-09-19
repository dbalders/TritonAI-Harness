# TritonAI image request budget

Codex resends screenshots retained in conversation history. Its image-budget feature controls
image resolution, not a per-request image count, and the app-server API does not expose a
history-editing hook. Until Codex supports this limit, a request filter avoids maintaining a
custom Codex build.

`TritonAiImageProxy` keeps the three newest images across user messages and tool outputs in
Responses and compaction requests. It replaces older images with text markers, preserving
call IDs, other content, and the saved conversation. Three leaves one image of headroom below
the gateway's reported four-image limit.

Effect's existing Node HTTP client and scoped server own forwarding, streaming, cancellation,
and cleanup. The filter uses the session's HTTP(S) proxy settings and preserves API query
parameters. Codex bypasses outbound proxies for the loopback connection. Its custom-provider
requests use JSON; launch overrides disable compression and WebSockets to keep this contract
explicit. Provider probes and standalone text generation keep their direct API path.

This downstream integration is confined to Codex session launch. Remove it when upstream
Codex offers a configurable image-count limit; no provider-neutral orchestration change is needed.
