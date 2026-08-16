## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. `coverage-checklist.mjs validate` fails a PASS/FAIL row with no locator, a gate row left TODO, **a cited `file:line` that does not resolve in the tree**, and **a gate row citing its command without the gate's result**._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> root `docs/tests/_generated/surface-inventory.json` is absent on this branch and at merge-base `f881ce9`; no repository inventory generator is configured |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> root inventory absent; implementation evidence is tagged at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:5`, `packages/pi-better-background-tasks/src/runtime.test.ts:65`, and `packages/pi-better-background-tasks/src/e2e.test.ts:57` |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | public schemas are centralized at `packages/pi-better-background-tasks/src/tools.ts:19`; spawn/watch expansion is centralized at `packages/pi-better-background-tasks/src/runtime.ts:71` and `packages/pi-better-background-tasks/src/runtime.ts:142` |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | #185 changes Pi extension tools/runtime services, not browser routes or HTTP APIs |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | literal argv/metadata and runner delegation at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:8`; durable runtime outcomes at `packages/pi-better-background-tasks/src/runtime.test.ts:68` and `packages/pi-better-background-tasks/src/runtime.test.ts:147` |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> root inventory absent, so tagged unit/integration evidence cannot be mechanically graded |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | #185 has no browser traffic interception; SSH is external and substituted through `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5` |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings; `lint-tests.mjs --rules mock-internal-seam` -> 0 findings whole-tree |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | only external process execution is faked at `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5`; real registry, scheduling, conditions, and metadata are exercised at `packages/pi-better-background-tasks/src/runtime.test.ts:68` |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | argv safety and validation are asserted at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:8`; terminal status and persisted metadata at `packages/pi-better-background-tasks/src/runtime.test.ts:68`; public labels at `packages/pi-better-background-tasks/src/e2e.test.ts:129` |
| Every new branch / error path has a driving test | lead | PASS | optional/full argv branches at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:8`, forced safety options at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:74`, invalid intent at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:103`, local/remote runtime branches at `packages/pi-better-background-tasks/src/runtime.test.ts:68` and `packages/pi-better-background-tasks/src/runtime.test.ts:133` |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | #185 declares the SSH-specific label/launch change; unchanged local paths remain covered at `packages/pi-better-background-tasks/src/e2e.test.ts:99`, `packages/pi-better-background-tasks/src/e2e.test.ts:166`, and `packages/pi-better-background-tasks/src/golden-path.test.ts:12` |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-185.json` -> 4 surfaces, 0 fail |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> root inventory absent; #185 itself changes no browser route |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | #185 changes no browser route or web-rendered surface |
| Sweep specs do not intercept first-party traffic | lead | N/A | #185 changes no browser route or sweep specification |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | #185 changes a terminal navigator and model-facing text only; its target label is asserted at `packages/pi-better-background-tasks/src/e2e.test.ts:129` |
| When the unit cites a design source (prototype/mockup/design doc): the parity manifest is complete, its citations resolve, and every pinned property holds against the rendered page | gate-lint | N/A | #185 cites no visual design source and changes no browser surface |
| Design source and deliverable rendered side by side at the floor viewports — the check that fails when the parity manifest itself is incomplete | judgment | N/A | #185 cites no visual design source and changes no browser surface |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `ci-audit.mjs --files .github/workflows/ci.yml,.github/workflows/integration-tests.yml,.github/workflows/publish.yml` (exit 1) -> inventory, accounting, sweep, E2E, mock-seam, checklist, evidence-block, quarantine-expiry, smoke, and all-gates are absent; inherited repository adoption gap |
