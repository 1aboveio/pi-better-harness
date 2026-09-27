# Issue #312 AC13 — baseline unit result

## Model readback

- Expected: `xai/grok-4.6` effort `high`
- Actual: `xai/grok-4.6` (`PI_PROVIDER=xai`, `PI_MODEL=grok-4.6`) effort `high` (`PI_REASONING_LEVEL=high`)
- Clone: `/Users/exoulster/projects/pi-better-harness/.resolve-issues/rush/issue-312/unit-baseline`
- Git root: same as clone (verified `git rev-parse --show-toplevel`)

## Branch / SHA

- Branch: `rush/312-baseline`
- Unit commit: recorded after commit via `git rev-parse HEAD`
- Product revision measured: `0f1f84c18d6df76cce7a4dcdfc2a276a4015abb9` (this unit added harness/docs only; no production or shared-package edits)

## Changed paths

- `scripts/issue-312-payload-baseline.mjs`
- `scripts/issue-312-payload-baseline.test.mjs`
- `scripts/issue-312-payload-baseline/isolate.mjs`
- `scripts/issue-312-payload-baseline/accounting.mjs`
- `scripts/issue-312-payload-baseline/fixtures.mjs`
- `scripts/issue-312-payload-baseline/run.mjs`
- `docs/issue-312-payload-baseline.md`
- `docs/issue-312-payload-baseline.json`
- `RESULT.md`

## Commands executed

```bash
git checkout -b rush/312-baseline
node --import tsx --test scripts/issue-312-payload-baseline.test.mjs
node --import tsx scripts/issue-312-payload-baseline.mjs --phase before \
  --json-out docs/issue-312-payload-baseline.json \
  --md-out docs/issue-312-payload-baseline.md
node /Users/exoulster/.agents/skills/test-quality/scripts/lint-tests.mjs \
  --files scripts/issue-312-payload-baseline.test.mjs
git diff --check
```

No model calls were used to seed runs.

## Baseline results (UTF-8 bytes)

Registered-tool `content` and callback `sendMessage` payloads from current base:

| id | UTF-8 bytes | exceeds proposed | ordered tool sequence |
|---|---:|---|---|
| subagent.success.result | 389 | no | yes (`bash, read, bash, write, edit`) |
| subagent.success.output | 264 | no | yes (`tools used:`) |
| subagent.success.callback | 321 | no | no |
| subagent.failed.result | 417 | no | yes |
| subagent.failed.callback | 327 | no | no |
| subagent.incomplete.result | 262775 | yes (8 KiB) | yes |
| subagent.incomplete.callback | 375 | no | no |
| subagent.orphaned.result | 952 | no | yes |
| subagent.orphaned.callback | 437 | no | no |
| subagent.unicode.result | 7896 | no | yes |
| subagent.many_failures.result | 2169 | no | yes; 7 extra incidents counted |
| subagent.list | 3020 | no | no |
| background.success.status | 481 | no | no |
| background.success.status.wrapper | 481 | no | wrapper equals standalone |
| background.success.log | 251 | no | no |
| background.failed.status | 881 | no | compact `result: failure_when`; no `Condition matched:` line |
| background.repeated_poll.status | 561 | no | 80 identical polls seeded |
| background.repeated_poll.log.default | 496 | no | 5-line tail |
| background.repeated_poll.log.full | 10259 | no | 80 polls retained in 512 KiB window |
| background.unicode.status | 2692 | yes (2 KiB) | lastState clipped with `…` |
| background.unicode.log | 7821 | yes (4 KiB) | single long JSON line 7647 B |
| background.many_failures.status | 2274 | yes (2 KiB) | 7 extra incidents counted |
| background.many_failures.list | 2360 | no | failure paragraphs repeated per row |
| callback.many_completions.batch | 14546 | yes (8 KiB) | 50 events, no aggregate cap |

Full facts, SHA-256 (of actual content including host log paths), limitations, and proposed-budget table: `docs/issue-312-payload-baseline.md` and `.json`.

These numbers are **not** blessed as correct product behavior. They are the BEFORE capture for AC13.

## Integration usage (AFTER)

```bash
# same clone after product changes, or any worktree with this harness
node --import tsx scripts/issue-312-payload-baseline.mjs --phase after \
  --json-out docs/issue-312-payload-baseline-after.json \
  --md-out docs/issue-312-payload-baseline-after.md
```

Programmatic: `isolateHarnessEnv()` then `collectBaseline({ phase: "after" })` from `scripts/issue-312-payload-baseline/run.mjs`. Compare by `id`. Prefer `facts.utf8BytesExcludingIsolatedTmpdir` when log-path prefixes differ. Intended deltas: smaller ordinary payloads, no ordered tool-name sequences in ordinary results/output, explicit omission/continuation, matched-condition/stop/gap facts before progress.

Do not pin BEFORE hashes as a regression test.

## Scope check

- Production / shared packages: unchanged
- Credentials: only synthetic marker `issue-312-synthetic`; harness fails if credential-like strings appear
- Test-quality lint: clean on the new test file
