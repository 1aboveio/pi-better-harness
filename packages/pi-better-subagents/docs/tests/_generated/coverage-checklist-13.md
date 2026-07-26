## Coverage Checklist — issue #13 (fix/13-tui-widget-flicker)

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue)._

Scope class: **surface-bearing** (index.ts, widget.mjs, widget.ts). No browser routes.

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | N/A | Repo has no inventory adapter / route manifest (pi extension, not Next.js). Hand-authored `docs/tests/_generated/surface-inventory.json` lists the five pure-helper surfaces introduced by this PR. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | `coverage-ledger.mjs validate` — 5 surfaces owned by `docs/tests/issue-13-widget-flicker.coverage.yml`; depthStatus=Unverified (unit tags present; awaits reviewer attestation). No Missing. Orphan warn pre-curation cleared by ownership file. |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | Diff only touches live-widget path + pure helpers (`widget.mjs`, `widget.ts`, `index.ts` widget section). No new tools/routes/APIs. list/finalize still use fmtElapsed/fmtSpend re-exports. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | Surfaces declared as library helpers in `docs/tests/_generated/surface-inventory.json:1` (kind=service); no route kind. Clear is the only mutation-class surface (`widget.clear`). |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff origin/main` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff origin/main` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/widget_flicker.test.mjs` asserts dirty-check skip, fixed widths, WIDGET_CLEAR===undefined, spinner rotation, spend-cache TTL/logSize, index.ts wiring. No vacuous renders. |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | Floor=unit via curated yml; tests tagged `@level unit`. Ledger: no Wrong Level findings. |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | PASS | No browser/journey tests; no page.route/MSW. N/A path with evidence: zero intercept markers in `tests/widget_flicker.test.mjs`. |
| No mock of a first-party internal seam module | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff origin/main` + whole-tree → 0 findings |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | No mocks in added tests (`tests/widget_flicker.test.mjs` imports real `widget.mjs`). |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | Behavior asserts at `tests/widget_flicker.test.mjs:1` (linesEqual, nextWidgetAction op, fixed widths, spinner glyphs); pure functions — no page/DOM. |
| Every new branch / error path has a driving test | lead | PASS | Branches covered in `tests/widget_flicker.test.mjs:1`: nextWidgetAction set/skip/clear; isSpendCacheFresh fresh/TTL/logSize/missing; buildWidgetLines with/without spend+tool. Dead branch removed in `widget.mjs` nextWidgetAction. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | Intended behavior change declared by issue #13 ACs (dirty-check, undefined clear, fixed width, spend cache). Prior thrash path replaced deliberately; RED wiring tests failed on pre-fix index.ts then went green. |
| Runtime smoke: each changed non-browser surface was actually run | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results.json` — `node --test tests/*.test.mjs` 48/48 pass; `node --experimental-strip-types --check index.ts` ok |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | No browser routes in diff (pi TUI extension widget helpers only). |
| Presentation sweep ran (runtime gate) | gate-lint | N/A | No browser routes; classifier surface-bearing library/TUI helpers. |
| Sweep specs do not intercept first-party traffic | lead | N/A | No sweep specs. |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | No browser surface; geometry stability asserted at unit level via fixed-width line lengths (`tests/widget_flicker.test.mjs` geometry suite). |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | N/A | This repo's CI is deliberately lightweight (`node --check` + `node --test tests/*.test.mjs` per `.github/workflows/ci.yml`); full ensure-coverage CI contract is not adopted. Producer ran lint-tests + ledger + scan-diff + unit tests locally. |
