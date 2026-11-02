# pi-better-model-router

Select `router/deepseek-flash-auto` once. Pi chooses DeepSeek or Ollama Cloud by the current price at the start of each user turn.

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

Authenticate DeepSeek through `/login`. Install and authenticate `pi-ollama-cloud` to enable the other route. Open `/model`, confirm both physical model IDs, then select **DeepSeek Flash Auto**. One authenticated candidate is enough; no available candidates produces an actionable error.

The router reuses provider authentication and streaming. It does not store keys or start a proxy. It does not select itself as the session default.

## Routing policy

- Compare estimated uncached input and output cost using each provider's current schedule.
- Keep the previous provider when costs tie; otherwise prefer `preferredProvider`, then candidate order.
- Keep tool follow-ups on the chosen provider, even across a price boundary.
- On a transient retry (rate limit, overload, timeout, or selected network/server errors), exclude the failed provider for the rest of that user turn.
- Preserve the failed model on other retries, including context overflow.
- Stop with an error when all candidates are unavailable or excluded. A new user turn clears exclusions.
- Direct requests, such as compaction summaries, compare prices independently.

Pi records the physical provider and model on responses and displays its native routed-model indicator. Pi clamps the selected thinking level to the physical model's supported levels.

## Configuration

The router reads `<Pi agent directory>/model-router.json` (normally `~/.pi/agent/model-router.json`), then `<project>/.pi/model-router.json`. Project fields override user fields. Arrays replace whole arrays. Configuration is read before each request; malformed or unreadable files report their path.

Example with the default rates and schedules:

```json
{
  "preferredProvider": "deepseek",
  "estimatedInputTokens": 10000,
  "estimatedOutputTokens": 2000,
  "candidates": [
    {
      "provider": "deepseek",
      "model": "deepseek-flash",
      "peak": { "input": 0.30, "cacheRead": 0.006, "output": 1.20 },
      "offPeak": { "input": 0.15, "cacheRead": 0.003, "output": 0.60 },
      "peakWindows": [[60, 240], [360, 600]],
      "offPeakDates": []
    },
    {
      "provider": "ollama-cloud",
      "model": "deepseek-v4.1-flash:cloud",
      "peak": { "input": 0.30, "cacheRead": 0.006, "output": 1.20 },
      "offPeak": { "input": 0.15, "cacheRead": 0.003, "output": 0.60 },
      "peakWindows": [[720, 1080]],
      "offPeakDates": []
    }
  ]
}
```

Prices are USD per million tokens. Windows use minutes after UTC midnight, include their start, and exclude their end. They apply Monday through Friday; weekends are always off-peak. Split windows at midnight. Model IDs must match the physical catalog exactly; override the Ollama ID if your catalog uses another tag.

**DeepSeek excludes Chinese public holidays from peak pricing. Add those UTC calendar dates to its `offPeakDates`.** The default date list is empty; the router does not download a holiday calendar. Rates and schedules are a configurable snapshot, not a live pricing feed.

The token estimates are routing weights, not a prediction of actual usage. The router does not assume that a provider has a warm cache. It may switch to a cheaper rate even when rebuilding the cache costs more. Staying on the previous provider when rates tie reduces unnecessary cache loss.

`cacheRead` records the published rate for configuration completeness; it is not used in the comparison because cache hits cannot be predicted reliably. Routing does not rewrite provider cost metadata. Pi's displayed costs remain provider estimates; Ollama Cloud does not report cached-token usage through its completion API. Subscription credits are not treated as free tokens.

## Development

```sh
npm run typecheck -w packages/pi-better-model-router
npm test -w packages/pi-better-model-router
```

Sources: [Pi virtual models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/), [Ollama pricing](https://ollama.com/pricing).
