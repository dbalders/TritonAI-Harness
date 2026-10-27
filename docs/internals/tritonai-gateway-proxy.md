# TritonAI gateway proxy

Codex sessions reach the TritonAI gateway through a local request filter,
`TritonAiGatewayProxy`. Codex's app-server API has no history-editing or request-body hook, so
the filter avoids maintaining a custom Codex build. It changes only what one request sends; the
saved conversation and Codex's own history stay complete.

## Image budget

The filter keeps the four newest images across user messages and tool outputs in Responses and
compaction requests. Older images become text markers, preserving call IDs and other content.
The cap matches the gateway's four-image limit.

## Context window guard

The gateway serves campus-hosted (vLLM) models through LiteLLM. Three gaps let one thread exceed
the model's context window and then fail on every later message:

- **Runaway replies.** Codex sends no output limit. A hosted model that loops (for example,
  re-typing an encoded attachment into a command, or counting words by hand in its reasoning) keeps
  writing until the window is full. Requests for on-prem models in the managed catalog get
  `max_output_tokens` of 32,768. When a reply hits that limit after producing a tool call or
  message, the filter reports the response as completed: Codex would otherwise retry the same
  reply up to five times. Codex then tells the model that the cut-off call could not be parsed.
- **Replayed model output.** Codex caps tool output, but resends the model's own text, reasoning,
  and tool arguments in full. Each such history item is shortened to 40,000 characters, keeping
  tool arguments valid JSON (the gateway drops arguments it cannot parse).
- **Unrecognized overflow.** LiteLLM reports overflow as a generic HTTP 400 that Codex shows raw
  and never recovers from. Codex 0.161 also cannot mark the window full after an overflow:
  `TokenUsageInfo::fill_to_context_window` measures room against the thread's cumulative token
  total, so a long thread is marked as empty. On overflow, the filter retries the request with
  progressively more of the oldest history left out, in whole tool-call pairs, keeping
  instructions, Codex's injected context, the latest user message, and the current turn's
  recent work. A note tells the model that earlier items were left out. The accepted request
  reports large usage, so Codex compacts the thread normally afterward. If nothing more can be
  left out, the filter returns Codex's `context_length_exceeded` failure and Harness shows a
  plain message instead of the gateway's JSON.

## Transport

Effect's Node HTTP client and scoped server own forwarding, streaming, cancellation, and cleanup.
The filter uses the session's HTTP(S) proxy settings and preserves API query parameters. Codex
bypasses outbound proxies for the loopback connection. Its custom-provider requests use JSON;
launch overrides disable compression and WebSockets to keep this contract explicit. Provider
probes and standalone text generation keep their direct API path.

This downstream integration is confined to Codex session launch. Remove each part when upstream
Codex or the gateway provides it: an image-count limit, an output limit, a recognized overflow
error, and correct window accounting after overflow.
