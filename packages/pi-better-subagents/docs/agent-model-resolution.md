# Agent model resolution

Resolver for DEV-23 model and effort choices. `model-resolution.ts` and `tier-policy.ts` do not spawn a child and do not edit the catalog. Lifecycle calls them before `spawnSubagentRun`.

Normative rules are R3, R4, R8, and the resolver half of R10. Prose parsing and real Pi delegation stay with the acceptance unit.

## What the resolver will not do

- It does not read a task, skill, or workflow string. A quoted model or a comparison in the prompt is not a selection. The coordinator translates an authoritative instruction into `invocation` or `authoritative` first.
- It does not grant tools, sandbox modes, extensions, or presets. Inspection copies the catalog `capabilities` object (`grantedByCatalog: false`).
- It does not call a provider. Availability is one `getAvailable()` snapshot from the foreground registry. `find()` only explains that a known model is outside that set.
- It does not retry, and it does not substitute after a child has started. `automaticRetry` and `substitutionAfterStart` are false. `startupFailure.action` is `surface-error-no-retry-no-substitution`. A later provider initialization failure is a lifecycle error.
- It does not invent tier candidates. Built-in tiers name the approved models and have empty candidate lists. `openai/gpt-6-sol`, `openai/gpt-6-luna`, and `openai/gpt-6-astra` are not substitutes.

## Precedence

Model and effort are independent. A model-only choice keeps the resolved effort. Falling back to another model, including the foreground model, does not copy that model's effort.

Effort, highest first:

1. Invocation `thinking`.
2. `@effort` on the invocation model.
3. Authoritative `effort`, otherwise `@effort` on the authoritative model.
4. Saved agent effort override, including an explicit null. Null clears the role effort. The field's `explicit` flag is the provenance.
5. Role default.

Model, highest first:

1. Invocation model, with a providerless id accepted only when one available model has that id.
2. Authoritative model. Same providerless rule. Read only when `effective` is present, so catalog-free calls stay on the old chain.
3. Saved agent model, otherwise the role model.
4. If that preferred model is missing or not available: the first eligible configured candidate of the definition's tier, otherwise the foreground model.
5. If the definition has no model preference (absent, or an explicit null override): configured `defaultModel` when it is available, otherwise the foreground model. Tier candidates are not used.

An explicit invocation or authoritative model that is unavailable, ambiguous, or paired with an unsupported effort blocks launch. Lower sources are not fallbacks. A saved model override is a preferred default, so it may fall through the tier and foreground chain. A saved effort override stays explicit on that fallback: an unsupported level blocks launch instead of moving to a nearby level.

## Tier candidates

`configureTierPolicy` replaces a tier's `{ members, candidates }` and leaves the other built-in tiers in place. Candidate order is the array order. A candidate is eligible only when all of these hold:

- It is `provider/model`.
- That exact string is in the tier's `members`.
- It is in the foreground available set.
- Its provider matches the preferred model, or `crossProvider: true`. A string candidate does not opt into another provider.

An unknown tier name, or a missing tier, does not borrow another tier. The reason is recorded and the resolver goes to the foreground model. If the foreground model is also unusable, the decision is blocked. The diagnostic says no child was started and how to recover.

## Effort support

Supported levels are Pi's `getSupportedThinkingLevels` for the resolved registry model (`reasoning` and `thinkingLevelMap`). Registry rows without a boolean `reasoning` field are ignored rather than guessed.

An inherited level that is unsupported becomes the nearest level on `off < minimal < low < medium < high < xhigh < max`. Equal distance keeps the lower level. This is not Pi's `clampThinkingLevel`, which searches upward first. The decision records requested effort, actual effort, source, and the reason. Explicit invocation, authoritative, and saved-override levels are never adjusted.

## Catalog-free calls

Omit `effective`. The chain is the invocation model, then configured `defaultModel`, then the foreground model string. Explicit `thinking` wins over a suffix on that selected string. The strings are not checked against the registry and effort is not adjusted. Invalid suffixes still block, matching `parseModelThinking`. `authoritative` is ignored so this path cannot grow a new input.

## Spawn contract

```ts
const decision = resolveModel({
  effective, // omit for catalog-free
  invocation: { model, thinking },
  authoritative: { model, effort },
  registry: ctx.modelRegistry,
  tiers,
  foregroundModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
  configuredDefaultModel: config.defaultModel,
});

if (decision.status !== "ready") {
  // return decision.diagnostics; do not spawn
}
const { model, thinking } = launchParameters(decision);
```

`launch` is null when `status` is `"blocked"`. `modelSelection.actual` on a blocked effort decision is the model that was considered, not permission to spawn. `launchParameters` throws if called on a blocked decision.

Persist `modelSelection` and `effortSelection` (`requested`, `actual`, `source`, `explicit` / `explicitRequest`, `reason`) with the run. Do not rewrite them after startup failure.

## Inspection

`assessSelection` and `assessCatalog` attach default-launch availability to a snapshot. They do not apply invocation overrides. `schemaLaunchable` false stays `availability: "catalog-blocked"` and does not fall back to a model. A schema-valid role whose preferred model is missing can still be `launchable` when a candidate or the foreground model resolves. `capabilities` is the catalog object, not a new grant.

`/agents` and `agents_catalog` can show `launchable`, `availability`, `preferredModelAvailable`, and the decision's requested/actual/source/reason beside the existing inherited-versus-override fields.
