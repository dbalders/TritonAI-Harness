# LiteLLM and GLM-5.2 pricing

Research date: 2026-08-31

## Conclusion

The zero cost for transcript model `api-glm-5.2` is a lookup gap, not evidence that GLM-5.2 has become free or disappeared.

- Z.AI still documents `glm-5.2` as a current API model and still publishes its price.
- TritonAI has retired `api-glm-5.2` from its managed catalog and routes new selections to `api-glm-5.3`, but old transcripts correctly retain the historical `api-glm-5.2` identifier.
- LiteLLM's current cost map has no exact `zai/glm-5.2`, `glm-5.2`, or `api-glm-5.2` entry. It does have GLM-5.2 entries for other hosting providers, whose prices are not interchangeable.
- The safe estimate for historical TritonAI `api-glm-5.2` records is a version-specific local mapping to Z.AI's published GLM-5.2 public API rate. It should remain labelled as an estimated full-API-rate cost, not actual UCSD infrastructure spend.

## Canonical identifiers and current status

| Context                          | Identifier    | Status                                                                                                                           |
| -------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Z.AI request body                | `glm-5.2`     | Current. Z.AI's live Chat Completion reference includes it in the model enum, and its GLM-5.2 guide uses it in request examples. |
| Expected LiteLLM direct-Z.AI key | `zai/glm-5.2` | Missing from the current LiteLLM cost map. Adjacent direct-Z.AI entries include `zai/glm-5`, `zai/glm-5.1`, and `zai/glm-5.3`.   |
| TritonAI historical model ID     | `api-glm-5.2` | Retired from the current managed catalog, but present in historical transcripts.                                                 |
| TritonAI current replacement     | `api-glm-5.3` | Current managed default. TritonAI explicitly maps `api-glm-5.2` selections to `api-glm-5.3`.                                     |

Primary evidence:

- Z.AI's [GLM-5.2 guide](https://docs.z.ai/guides/llm/glm-5.2) identifies the model as `glm-5.2`, documents its 1M context and 128K maximum output, and provides live API examples.
- Z.AI's [Chat Completion reference](https://docs.z.ai/api-reference/llm/chat-completion) currently lists `glm-5.2` among the available model values.
- LiteLLM's cost map at reviewed main commit [`10631eb8`](https://github.com/BerriAI/litellm/blob/10631eb834c7802aa61611e807474170b8a4d425/model_prices_and_context_window.json#L44835-L44895) jumps from direct-Z.AI `zai/glm-5` to `zai/glm-5.3`, then `zai/glm-5.1`; it contains no direct `zai/glm-5.2` entry.
- TritonAI's [managed config](https://github.com/dbalders/TritonAI-Harness/blob/6697b6112a9f95b57560f2c096627943a61b3aa9/config/tritonai-managed-config.json#L27-L47) sets `api-glm-5.3` as the default and maps `api-glm-5.2` to it. This is a routing/catalog replacement, not a historical-pricing alias.

GLM-5.2 therefore has not been removed from Z.AI's model API. It has been retired from TritonAI's current managed catalog, while LiteLLM independently has a missing direct-Z.AI cost-map entry.

## Applicable public API rate

Z.AI's [current pricing table](https://docs.z.ai/guides/overview/pricing) publishes the following GLM-5.2 prices in USD per 1 million tokens:

| Token class                 |   USD / 1M tokens |                          USD / token | LiteLLM field                     |
| --------------------------- | ----------------: | -----------------------------------: | --------------------------------- |
| Uncached input              |             $1.40 |                             `1.4e-6` | `input_cost_per_token`            |
| Cached input read           |             $0.26 |                             `2.6e-7` | `cache_read_input_token_cost`     |
| Cached input storage/write  | Limited-time free | `0` while that offer remains current | `cache_creation_input_token_cost` |
| Output, including reasoning |             $4.40 |                             `4.4e-6` | `output_cost_per_token`           |

There is no separately published GLM-5.2 reasoning-token price. Z.AI exposes thinking as `reasoning_content`, says thinking consumes extra tokens, and reports a single `completion_tokens` total as the number of output tokens. See Z.AI's [Deep Thinking response and token note](https://docs.z.ai/guides/capabilities/thinking#response-example) and [Chat Completion usage schema](https://docs.z.ai/api-reference/llm/chat-completion#response). Therefore reasoning tokens already included in transcript output totals should be charged once at the output rate, not added a second time.

Z.AI reports cache hits under `usage.prompt_tokens_details.cached_tokens`; its [context-caching guide](https://docs.z.ai/guides/capabilities/cache) describes those tokens as lower-priced input. The published "Cached Input Storage" price is a promotional state, so a long-lived implementation should refresh it from the upstream table rather than assuming permanent zero-cost writes.

Using the rounded values visible in the reported usage screen—263K cached input, 57K uncached input, and 4.54K output—the public-rate estimate is approximately:

```text
(263,000 × $0.26 / 1M) + (57,000 × $1.40 / 1M) + (4,540 × $4.40 / 1M)
= $0.168156, or about $0.17
```

## Why an arbitrary LiteLLM GLM-5.2 match is unsafe

LiteLLM does contain provider-specific GLM-5.2 keys. Examples in the reviewed map include:

- [`cloudflare/@cf/zai-org/glm-5.2`](https://github.com/BerriAI/litellm/blob/10631eb834c7802aa61611e807474170b8a4d425/model_prices_and_context_window.json#L13300-L13311): $1.40 input, $0.26 cached input, $4.40 output per 1M.
- [`dashscope/glm-5.2`](https://github.com/BerriAI/litellm/blob/10631eb834c7802aa61611e807474170b8a4d425/model_prices_and_context_window.json#L13811-L13825): $1.40 input, $0.28 cached input, $4.40 output per 1M.
- [`mistral/zai-glm-5-2` and `mistral/glm-5-2`](https://github.com/BerriAI/litellm/blob/10631eb834c7802aa61611e807474170b8a4d425/model_prices_and_context_window.json#L31268-L31300): $1.40 input, $0.14 cached input, $4.40 output per 1M.
- [`together_ai/zai-org/GLM-5.2`](https://github.com/BerriAI/litellm/blob/10631eb834c7802aa61611e807474170b8a4d425/model_prices_and_context_window.json#L39240-L39255): $1.40 input, $0.26 cached input, $4.40 output per 1M.
- [`deepinfra/zai-org/GLM-5.2`](https://github.com/BerriAI/litellm/blob/10631eb834c7802aa61611e807474170b8a4d425/model_prices_and_context_window.json#L54272-L54285): $0.75 input, $0.14 cached input, $2.40 output per 1M.

The Harness parser preserves each complete lowercased LiteLLM key and creates a bare alias only when every qualified candidate has the same rate. That prevents provider-specific keys such as Cloudflare, DashScope, Together, Novita, W&B, and DeepInfra from collapsing into one order-dependent `glm-5.2` price. See [`normalizeModelName` and `parseRateTable`](../../apps/server/src/usage/usagePricing.ts). Resolving `api-glm-5.2` through a loose suffix match would bypass that protection and could materially understate cost.

## Recommended matching rule

1. Preserve the complete lowercased LiteLLM key, including provider, in the parsed table. Exact provider-qualified matches should win.
2. Maintain an explicit, reviewed TritonAI alias table for gateway IDs. Resolve `api-glm-5.2` to a local `zai/glm-5.2` override containing the four Z.AI rates above until LiteLLM adds the missing direct-Z.AI key.
3. Do not resolve historical `api-glm-5.2` usage to `zai/glm-5`, which would undercount it at Z.AI's older $1.00 input / $3.20 output rates.
4. Do not permanently resolve it to `zai/glm-5.3` merely because the two models currently share prices. TritonAI's 5.2-to-5.3 replacement controls future model routing; historical usage should remain version-specific in case upstream prices diverge later.
5. Permit suffix-only fallback only when the candidate is unique or every matching provider entry has identical input, cache-read, cache-write, and output rates. Otherwise return `unpriced` rather than selecting a provider by document order.
6. Continue treating reasoning as part of output when the transcript's output total already includes reasoning.

This rule fixes the graph deterministically while preserving the page's honest meaning: an estimated raw token cost at Z.AI's full public API rate, not TritonAI's actual internal charge.
