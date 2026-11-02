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

Authenticate DeepSeek and Ollama Cloud through `/login`. The package bundles and loads `pi-ollama-cloud`; a separate plugin installation is not needed. Open `/model`, then select **DeepSeek Flash Auto**. One authenticated candidate is enough; no eligible candidates produces an actionable error.

The router reuses Pi's physical models, authentication, streaming, and model settings. Define custom endpoints, credentials, capabilities, and price overrides in Pi's normal provider configuration or `models.json`. No physical model needs to be defined again for the router.

## Policy configuration

No configuration file is needed for the default policy. To override it, use `<Pi agent directory>/model-router.json` (normally `~/.pi/agent/model-router.json`) or `<project>/.pi/model-router.json`. Project fields override user fields. Changes apply before the next request.

A minimal explicit configuration is:

```json
{
  "type": "price",
  "preferredProvider": "deepseek"
}
```

`price` is currently the only supported policy type and is the default when omitted. It compares estimated request cost and uses `preferredProvider` to break ties at the start of a user turn.

Optional price and schedule overrides:

```json
{
  "type": "price",
  "preferredProvider": "deepseek",
  "pricing": {
    "deepseek": {
      "peak": { "input": 0.30, "output": 1.20 },
      "offPeak": { "input": 0.15, "output": 0.60 },
      "peakWindows": [[60, 240], [360, 600]],
      "offPeakDates": []
    },
    "ollama-cloud": {
      "peak": { "input": 0.30, "output": 1.20 },
      "offPeak": { "input": 0.15, "output": 0.60 },
      "peakWindows": [[720, 1080]]
    }
  }
}
```

Prices are USD per million tokens, not spending caps. Every field under `pricing` is optional. `peak` and `offPeak` accept `input`, `output`, and `cacheRead`. Missing peak fields use catalog prices. Missing off-peak fields use half the effective peak rate, including any peak override.

`peakWindows` uses minutes after UTC midnight, with start included and end excluded. Split overnight windows at midnight. An empty array makes all hours off-peak. `offPeakDates` contains UTC dates in `YYYY-MM-DD` form that are off-peak all day; use this to maintain DeepSeek holiday exceptions.

User and project pricing overrides merge per provider and rate field. Project arrays replace user arrays. For example, overriding only DeepSeek output price preserves a user-level input price and Ollama overrides.

For workloads where providers have different input/output price ratios, two optional weights control the comparison:

```json
{
  "type": "price",
  "estimatedInputTokens": 10000,
  "estimatedOutputTokens": 2000
}
```

The router compares `input rate × estimatedInputTokens + output rate × estimatedOutputTokens`. The common per-million divisor does not change the winning provider. These positive weights do not limit actual tokens or represent a spending budget. With matching provider rates and proportional discounts, changing them does not change the choice.

Model IDs, endpoints, and capabilities remain in Pi configuration. Unknown fields report an error. Older configurations containing `candidates` must remove that field; place model definitions in `models.json` and routing price overrides under `pricing`.

## Model discovery and prices

The router resolves authenticated physical models from Pi's available catalog on each request:

- DeepSeek: `deepseek-flash`, with `deepseek-v4-flash` as a legacy fallback.
- Ollama Cloud: `deepseek-v4.1-flash:cloud`, then `deepseek-v4.1-flash`, then an available version-tagged `deepseek-v4.1-flash:…` entry.

It uses the catalog's input, output, and cached-input cost metadata, including `models.json` overrides, then applies any policy price overrides. Models with missing, invalid, or zero input/output pricing produce an error rather than being treated as free, unless each zero input or output rate is explicitly supplied by the policy. Explicit zero-rate overrides are allowed.

By default, the bundled schedule treats catalog rates as **peak rates** and applies a 50% discount off-peak:

| Provider | Weekday peak windows, UTC |
| --- | --- |
| DeepSeek | 01:00–04:00 and 06:00–10:00 |
| Ollama Cloud | 12:00–18:00 |

Windows include the start and exclude the end. Weekends are off-peak. The schedule is a bundled integration rule, not a live pricing feed.

DeepSeek also excludes Chinese public holidays. The bundled holiday list is currently empty. Supply UTC dates through `pricing.deepseek.offPeakDates`; without those dates, the router treats holidays as ordinary weekdays and can choose Ollama unnecessarily.

## Routing behavior

- Compare estimated uncached input and output cost using catalog rates, bundled schedules, and policy overrides.
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
