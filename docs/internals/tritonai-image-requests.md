# TritonAI image request budget

Codex owns the conversation history and resends earlier image-bearing tool results in
Responses API requests. Limiting screenshots returned by a single computer-use call does
not bound the image count across that history. TritonAI's gateway can reject requests
containing more than four images. Harness caps requests at three to leave one image of headroom.

`TritonAiImageProxy` is a session-scoped loopback HTTP transport between the managed
Codex app-server and the configured TritonAI API. It replaces all but the three newest
image parts in Responses and compaction requests with text markers. User attachments,
function tool results, and custom tool results share the budget. It retains message order,
text, and call IDs, and never rewrites Codex's persisted history. Resumed conversations
and child agents using the session's provider configuration receive the same protection.

The transport preserves upstream status codes, headers, and streaming bytes. It decodes
compressed request bodies before pruning, binds only to loopback with an unpredictable
path, forwards to a fixed configured upstream, and closes with the runtime scope.
WebSocket transport is disabled for these sessions so requests cannot bypass pruning.
The upstream hop uses session-specific HTTP(S) proxy environment settings (including
`ALL_PROXY` fallback and `NO_PROXY` exclusions). The Codex child bypasses outbound
proxies for the local transport address.
Provider probes and standalone text generation keep their existing direct API path.

This is intentionally downstream: upstream T3 Code does not impose TritonAI's gateway
image limit. Integration requires only the Codex session launch boundary; provider-neutral
orchestration, desktop tools, and upstream Codex itself remain unchanged. Future upstream
syncs should retain this boundary until Codex exposes a configurable image-count budget.
