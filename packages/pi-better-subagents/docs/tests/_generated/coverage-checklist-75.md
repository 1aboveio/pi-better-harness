## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue)._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` cannot inventory this extension: no `coverage.config.json` or repository inventory adapter. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0 without output because this repo has no `coverage.config.json` or inventory adapter; no ownership/floor assertion is available. |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | `lifecycle.ts:9` owns finalization/result formatting only; `registry.ts:34` persists the diagnostic reason and adds no new entry surface. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | `index.ts:211` is an existing internal child-exit handler; `index.ts:520` is an existing tool read path; neither adds a route/API mutation surface. |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-skip --diff origin/main` → 0 findings. |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings. |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-empty-test --diff origin/main` → 0 findings. |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/parse_run.test.mjs:63` proves an unmatched pre-window start fails exit-0 despite a tail terminal; `tests/run_finalization.test.mjs:25` and `tests/incomplete_result.test.mjs:26` assert final status and raw-tail diagnostics. |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0 without output because this repo has no `coverage.config.json` or inventory adapter; no level floor can be resolved. |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | PASS | `tests/parse_run.test.mjs:63` writes a real bounded run log and calls the real parser/classifier; no browser/API interception exists in changed tests. |
| No mock of a first-party internal seam module (real internals, faked externals) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules mock-internal-seam --diff origin/main` and whole-tree equivalent → 0 findings. |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | `tests/parse_run.test.mjs:16` uses the real filesystem, parser, registry paths, and cleanup; no mocks were added. |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | `tests/incomplete_result.test.mjs:26` asserts diagnostic text plus parsed output and raw tail; `tests/callback_completion.test.mjs:166` rejects success wording. |
| Every new branch / error path has a driving test | lead | PASS | Full-stream/bounded-tail coherence: `tests/parse_run.test.mjs:63`; incomplete callback branches: `tests/callback_completion.test.mjs:166` and `:178`; classification branches: `tests/run_finalization.test.mjs:25`. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | Declared intended behavior change: issue #75 AC1-AC6; compatibility branch is pinned at `tests/run_finalization.test.mjs:62` with `@characterizes`. |
| Runtime smoke: each changed non-browser surface was actually run and its happy path responded | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-75.json` → `node --experimental-strip-types tests/smoke_midturn_exit.mjs` observed `SMOKE PASS: full-stream coherence rejects a bounded-tail exit-0 run`. |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | `index.ts:211` and `:520` are extension lifecycle/tool handlers; no browser route changed. |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | No browser route changed; see `index.ts:211` and `:520`. |
| Sweep specs do not intercept first-party traffic | lead | N/A | No browser sweep/spec is added by this extension-only change. |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | No browser-rendered surface changed. |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/ci-audit.mjs --files .github/workflows/ci.yml` → required inventory, ledger, checklist, evidence, smoke, and presentation gates absent from pre-existing CI configuration. |
