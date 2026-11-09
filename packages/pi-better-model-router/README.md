# pi-better-model-router

Select `router/deepseek-flash-auto` once. Pi chooses DeepSeek or Ollama Cloud by price at the start of each user turn, and moves a running turn when the other provider becomes strictly cheaper at a price boundary. DeepSeek is the default preferred provider.

## Requirements and setup

Requires Pi's native `registerVirtualModel` API (tested with Pi 1.4.0). Older hosts report an upgrade error. Install this package on its own, or use the pi-better-harness bundle, which includes the router and Ollama Cloud provider. The Harness bundle skips routing with an upgrade notice on older Pi hosts; the standalone router reports an upgrade error.

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

`price` is currently the only supported policy type and is the default when omitted. It compares estimated request cost and uses `preferredProvider` to break ties at the start of a user turn. Inside a turn, equal cost keeps the current provider.

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
- Keep a turn's model while it is still the cheapest, and move the turn to the other provider when that provider becomes strictly cheaper at a price boundary. Equal cost keeps the current provider, so a switch never pays a cold prompt cache for no gain.
- On a retry, send the request to the other candidate. A rejected request, such as a `400`, a bad schema, or an invalid key, keeps that provider out for the rest of the user turn; a timeout, connection failure, `429`, or overloaded endpoint only demotes it, so the turn keeps both routes.
- When every candidate is excluded but at least one failed transiently, retry the model the turn already uses instead of ending the turn. Only rejected requests can end it with no route left.
- Preserve the failed model only after a context overflow, because Pi retries that request after compacting the conversation and a switch would pay a cold cache.
- Report excluded and demoted providers as router state only when those lists change, so a long session does not append one state entry per request.
- Declare the virtual model's context limits as a pair that fits the provider window. Pi reads them whenever a response names no physical model, which is what the router's own routing error looks like, and an undeclared limit counts as zero. A zero window makes every conversation look over the compaction threshold, so Pi would compact after each routing error at any context size.

  Both candidates share one 1,048,576-token window between input and output, but Pi treats `contextWindow` as the input allowance and `maxTokens` as room beyond it. The router therefore declares an input budget of `1,048,576 - 64,000` beside a 64,000-token output budget, so the two add up to the provider window. Declaring the raw 1,048,576 window beside a large output budget promises capacity no endpoint has: a 746,917-token conversation plus a 384,000-token completion is 1,130,917 tokens, which the provider rejects. The same pair also keeps Pi's compaction trigger below the point where output stops fitting.
- Stop with an error when every candidate is unavailable or rejected. A new user turn clears the exclusions.
- Direct requests, such as compaction summaries, compare prices independently.

Pi records the physical provider and model on responses and displays its native routed-model indicator. Pi clamps the selected thinking level to the physical model's supported levels.

The router does not assume that a provider has a warm cache. Choosing a cheaper rate, or returning to the preferred provider on a tie, can lose cache savings. Cached-input prices are not used to compare routes because cache hits cannot be predicted reliably.

Routing does not rewrite provider cost metadata. Pi's displayed costs remain provider estimates; Ollama Cloud does not report cached-token usage through its completion API. Subscription credits are not treated as free tokens.

## Child dependency discovery

The package manifest exposes `pi.childRequirements: "./src/child-requirements.ts"` for hosts that prepare isolated child processes. This module is safe to import for discovery: it does not initialize the extension, load configuration, or access the model registry.

The named export `childModelRequirements(model: string)` and default export `(input: { model: string })` return the same requirements for `router/deepseek-flash-auto`:

```ts
{
  providers: ["deepseek", "ollama-cloud"],
  modelGroups: [
    { provider: "deepseek", ids: ["deepseek-flash", "deepseek-v4-flash"] },
    {
      provider: "ollama-cloud",
      ids: ["deepseek-v4.1-flash:cloud", "deepseek-v4.1-flash"],
      prefix: "deepseek-v4.1-flash:"
    }
  ]
}
```

Each model group describes alternatives for one provider: the ordered exact IDs, then any ID starting with `prefix` when present. Both providers are declared so a child can select either provider and retry through the other. The runtime still needs only one authenticated eligible candidate. Other model strings return `undefined`.

Requirements come from the exported `candidateSpecs` used by `resolveCandidates`; they include every selectable fallback regardless of price, schedule, or preferred provider. Each call returns fresh arrays. The host owns recursive dependency resolution and preflight checks.

## Development

```sh
npm run typecheck -w packages/pi-better-model-router
npm test -w packages/pi-better-model-router
```

Sources: [Pi virtual models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/), [Ollama pricing](https://ollama.com/pricing).
