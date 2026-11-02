# pi-better-model-router

Select `router/deepseek-flash-auto` once. Pi chooses DeepSeek or Ollama Cloud by price at the start of each user turn. DeepSeek is the default preferred provider.

## Requirements and setup

Requires Pi's native `registerVirtualModel` API (tested with Pi 1.4.0). Older hosts report an upgrade error. This package is standalone and is not included in the Harness bundle.

From this checkout:

```sh
pi install ./packages/pi-better-model-router
```

For a temporary run:

```sh
pi -e ./packages/pi-better-model-router
```

Authenticate DeepSeek through `/login`. Install and authenticate `pi-ollama-cloud` to enable the other route. Open `/model`, then select **DeepSeek Flash Auto**. One authenticated candidate is enough; no eligible candidates produces an actionable error.

The router reuses Pi's physical models, authentication, streaming, and model settings. Define custom endpoints, credentials, capabilities, and price overrides in Pi's normal provider configuration or `models.json`. No physical model needs to be defined again for the router.

## Policy configuration

No configuration file is needed for the default policy. To override it, use `<Pi agent directory>/model-router.json` (normally `~/.pi/agent/model-router.json`) or `<project>/.pi/model-router.json`. Project fields override user fields. Changes apply before the next request.

The complete policy schema is:

```json
{
  "preferredProvider": "deepseek",
  "estimatedInputTokens": 10000,
  "estimatedOutputTokens": 2000
}
```

- `preferredProvider` is either `deepseek` or `ollama-cloud`. It wins when prices tie at the start of a user turn.
- The positive token estimates weight input versus output cost. They do not limit actual tokens or predict usage.

A minimal explicit configuration is:

```json
{
  "preferredProvider": "deepseek"
}
```

Model IDs, endpoints, prices, capabilities, and schedules are not accepted in this policy file. Unknown fields report an error. Older configurations containing `candidates` must remove that field; move physical model overrides into `models.json`.

## Model discovery and prices

The router resolves authenticated physical models from Pi's available catalog on each request:

- DeepSeek: `deepseek-flash`, with `deepseek-v4-flash` as a legacy fallback.
- Ollama Cloud: `deepseek-v4.1-flash:cloud`, then `deepseek-v4.1-flash`, then an available version-tagged `deepseek-v4.1-flash:…` entry.

It uses the catalog's input, output, and cached-input cost metadata, including `models.json` overrides. Models with missing, invalid, or zero input/output pricing produce an error rather than being treated as free.

The bundled schedule treats catalog rates as **peak rates** and applies a 50% discount off-peak:

| Provider | Weekday peak windows, UTC |
| --- | --- |
| DeepSeek | 01:00–04:00 and 06:00–10:00 |
| Ollama Cloud | 12:00–18:00 |

Windows include the start and exclude the end. Weekends are off-peak. The schedule is a bundled integration rule, not a live pricing feed.

DeepSeek also excludes Chinese public holidays. The bundled holiday list is currently empty, so the router conservatively treats those weekdays as ordinary weekdays. It can choose Ollama unnecessarily during those exceptions. Holiday-calendar support is not exposed as model configuration.

## Routing behavior

- Compare estimated uncached input and output cost using catalog rates and the bundled schedule.
- On equal cost, prefer DeepSeek by default. If the preferred provider is unavailable, preserve the previous eligible model, then use candidate order.
- Keep tool follow-ups on the chosen provider, even across a price boundary.
- On a transient retry (rate limit, overload, timeout, or selected network/server errors), exclude the failed provider for the rest of that user turn.
- Preserve the failed model on other retries, including context overflow.
- Stop with an error when all candidates are unavailable or excluded. A new user turn clears exclusions.
- Direct requests, such as compaction summaries, compare prices independently.

Pi records the physical provider and model on responses and displays its native routed-model indicator. Pi clamps the selected thinking level to the physical model's supported levels.

The router does not assume that a provider has a warm cache. Choosing a cheaper rate, or returning to the preferred provider on a tie, can lose cache savings. Cached-input prices are not used to compare routes because cache hits cannot be predicted reliably.

Routing does not rewrite provider cost metadata. Pi's displayed costs remain provider estimates; Ollama Cloud does not report cached-token usage through its completion API. Subscription credits are not treated as free tokens.

## Development

```sh
npm run typecheck -w packages/pi-better-model-router
npm test -w packages/pi-better-model-router
```

Sources: [Pi virtual models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/), [Ollama pricing](https://ollama.com/pricing).
