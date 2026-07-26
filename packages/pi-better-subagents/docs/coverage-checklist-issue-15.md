## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. A PASS/FAIL row with no locator, or a gate row left TODO, fails `coverage-checklist.mjs validate`._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | N/A | no browser route inventory / gen-inventory in this pi extension repo (`package.json` is extension-only) |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | `tests/parent_ownership.test.mjs` `@covers parent-ownership` `@level unit`; command: `node --test tests/*.test.mjs` |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | issue #15 ACs cover widget, list default, concurrency, session_start ticker, id recovery; all addressed in `index.ts` / `registry.ts` |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | no HTTP/API routes; local extension tools only |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | command: `node --test tests/*.test.mjs` (24 pass, 0 skipped) |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `git diff origin/main...HEAD` has no sleep/waitForTimeout |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `tests/parent_ownership.test.mjs` uses `assert.equal` / `assert.deepEqual` |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/parent_ownership.test.mjs` asserts owned vs foreign spawnPid and default-vs-all list filter |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `@level unit` on pure helper — appropriate floor for `ownedByThisParent` |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no browser / Playwright tests in diff |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | no `vi.mock`/`jest.mock` in `tests/parent_ownership.test.mjs`; scan-diff findings empty |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | N/A | no mocks; not money/auth surface |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | `tests/parent_ownership.test.mjs` assert.equal/deepEqual on ownership; command: `node --test tests/parent_ownership.test.mjs` |
| Every new branch / error path has a driving test | lead | PASS | true/false `ownedByThisParent`; default list filter excludes foreign; all path retains foreign (`tests/parent_ownership.test.mjs`) |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | intended change declared in issue #15 ACs (parent-scoped widget/list/concurrency) |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | command: `node --test tests/*.test.mjs` (24 pass); `ownedByThisParent` imported and exercised |

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
| CI wires all required gates and keeps them blocking | gate-lint | PASS | `.github/workflows/ci.yml` runs `node --test tests/*.test.mjs` on PR |
