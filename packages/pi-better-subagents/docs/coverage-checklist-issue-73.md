## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. A PASS/FAIL row with no locator, or a gate row left TODO, fails `coverage-checklist.mjs validate`._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | N/A | no browser route inventory / gen-inventory in this pi extension repo (`package.json` is extension-only) |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | N/A | no `docs/tests/_generated/surface-inventory.json` in this repo; changed parser/formatter seams are covered by unit tests in `tests/parse.test.mjs` |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | issue #73 ACs cover bounded tail parsing, truncation diagnostics, raw-tail fallback, and completed/failed/killed compatibility; all addressed in `parse.ts` / `index.ts` |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | no HTTP/API routes; local extension tools only |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff origin/main` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff origin/main` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/parse.test.mjs` asserts `finalText`, `lastActivity`, `toolCalls`, `sawEnd`, `usage`, and `diagnostics` for each scenario; formatter helpers assert body/diagnostics composition |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | N/A | no surface inventory / ledger in this repo; `@level unit` is appropriate for parser/formatter helpers |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no browser / Playwright tests in diff |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff origin/main` → 0 findings; `lint-tests.mjs --rules mock-internal-seam` → 0 findings |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | no `vi.mock` / `jest.mock`; tests use real `node:fs` I/O against temp run dirs |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | `tests/parse.test.mjs` asserts parser output state, not DOM/HTTP status |
| Every new branch / error path has a driving test | lead | PASS | truncation branch: `tests/parse.test.mjs:surfaces recent tool events from a huge log`; empty/unparseable branch: `reports explicit diagnostics when no parseable events are found`; MAX_STRING_LENGTH branch: `does not throw ERR_STRING_TOO_LONG`; `tailLog` empty branch: `returns '(no output yet)'`; formatter branches: `formatSubagentOutputBody` / `formatSubagentResultBody` suites |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | intended change declared in issue #73 ACs; existing small-log behavior preserved by `parses a completed run final answer` and `falls back to the last assistant message` tests |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `node --experimental-strip-types --test tests/parse.test.mjs` → 19 pass, 0 fail; `node --experimental-strip-types --test tests/*.test.mjs` → 112 pass, 0 fail |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | no browser routes in this extension |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | no browser routes |
| Sweep specs do not intercept first-party traffic | lead | N/A | no browser routes |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | no browser routes |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `ci-audit.mjs --files .github/workflows/ci.yml` reports all ensure-coverage gates absent; this is a pre-existing repo gap, not introduced by this PR (`.github/workflows/ci.yml` only runs unit tests) |
