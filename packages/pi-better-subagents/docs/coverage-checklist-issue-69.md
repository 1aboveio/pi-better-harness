## Coverage Checklist — issue #69 (TUI navigator + detail health)

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows auto-filled by tools then completed; lead/judgment rows completed by the producer for reviewer adjudication._

Issue: #69. Scope class: `surface-bearing` (changed runtime paths: `navigator.mjs`, `health-surface.mjs`, `index.ts`). No browser routes.

Base: `origin/main` @ `decb6a0`. ADR: `docs/adr/0002-process-group-only-subagent-health.md`. Reuses #66/#67 observation + surface helpers; no log reparse hot path beyond existing size/mtime cache.

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | PASS | `docs/tests/_generated/surface-inventory.json` — `navigator.health`, `navigator.detail-health` added. No browser route inventory in this pi extension repo |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | ownership via `docs/tests/issue-69-tui-health.coverage.yml`; proving tests `tests/navigator_health.test.mjs` tagged `@covers navigator.health` / `navigator.detail-health` `@level unit` |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | ACs map to navigator row order/status/facts/color + detail health sections. Plan: `docs/plans/issue-69-tui-health.md`. No list/widget contract change (#67), no stop/restart redesign (#68) |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | `navigator.health`/`navigator.detail-health`=read rendering seams; index wiring only feeds observations into pure builders |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | command: `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-skip --diff origin/main` → 0 findings |
| No fixed sleep added | gate-lint | PASS | command: `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings |
| No empty/placeholder test body added | gate-lint | PASS | command: `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-empty-test --diff origin/main` → 0 findings |
| Each added test actually asserts a behavior | lead | PASS | `tests/navigator_health.test.mjs` — 12 tests assert row order, fact cap, semantic colors, ANSI width, healthy silence, degraded facts, detail sections + separation, and legacy dead-running `status exited` never pairs with `liveness supervised` |
| Declared @level meets each surface floor | gate-lint | PASS | `@level unit` matches `requiredLevels: [unit]` in coverage yml |
| First-party interception in a behaviour/journey test is justified | lead | N/A | no browser / Playwright tests |
| No mock of a first-party internal seam module | gate-lint | PASS | real navigator/health-surface/observation modules; theme `fg` is external boundary stub |
| Mock use respects the boundary | judgment | PASS | observations via real `observeRunHealth`; no mocked first-party modules |
| Assertions are behavior-first | judgment | PASS | `tests/navigator_health.test.mjs` asserts rendered row text order, visible width, section labels, color markers, and detail `status exited` / `liveness terminal` coherence |
| Every new branch / error path has a driving test | lead | PASS | healthy/quiet/degraded/orphaned/lost/color/width/detail-section paths covered; effective-status/`exited` detail liveness coherence covered |
| Diffs that modify existing behavior are pinned | lead | PASS | Intended #69 row-order change (status moved to end) pinned by updated `tests/navigator_overlay.test.mjs` + new health suite; prior navigator suites still green |
| Runtime smoke: each changed non-browser surface was run | gate-lint | PASS | `node --experimental-strip-types tests/smoke_navigator_health.mjs` → SMOKE PASS 19/19; `docs/tests/_generated/runtime-smoke-results-69.json` |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | no browser routes |
| Presentation sweep ran | gate-lint | N/A | no browser routes |
| Sweep specs do not intercept first-party traffic | lead | N/A | no browser routes |
| Perceivability edge cases | judgment | N/A | no browser routes; TUI width/color covered at unit level |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | N/A | repo PR gate is type-strip + `node --test tests/*.test.mjs`; full ensure-coverage CI contract not adopted (pre-existing; precedent #67/#68) |
