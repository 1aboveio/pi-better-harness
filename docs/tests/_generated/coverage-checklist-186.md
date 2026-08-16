## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue)._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> `docs/tests/_generated/surface-inventory.json` is absent at HEAD and merge-base `f881ce9`; no repository inventory adapter/generator exists |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> inventory absent; implementation evidence is tagged at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:6` and `packages/pi-better-background-tasks/src/process.test.ts:20` |
| No un-specced capability missed - the surfaces no AC mentions | judgment | PASS | callable and all result branches are centralized in `packages/pi-better-background-tasks/src/remote-task-preset.ts:45`; process timeout behavior is centralized at `packages/pi-better-background-tasks/src/process.ts:39` |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | #186 changes a Pi extension integration/service seam and process runner, not a browser route or HTTP API |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | literal bootstrap outcomes and call sequencing are asserted at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:8`; real child termination is asserted at `packages/pi-better-background-tasks/src/process.test.ts:22` |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> root inventory absent, so tagged unit/integration evidence cannot be mechanically graded |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | #186 has no browser interception; only the external SSH/process boundary is substituted at `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5` |
| No mock of a first-party internal seam module (real internals, faked externals) - zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings; `lint-tests.mjs --rules mock-internal-seam` -> 0 findings whole-tree |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | external SSH responses are faked through `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5`; real process timeout/termination runs at `packages/pi-better-background-tasks/src/process.test.ts:22` |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | observable result, guidance, mutation, and command sequence assertions begin at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:8`; no browser surface exists |
| Every new branch / error path has a driving test | lead | PASS | present/install matrix at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:49`; auth, needs-user, disabled, unknown-PM, install-failed, re-probe, and timeout branches start at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:112` |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change - or an intended change is declared with its AC | lead | PASS | AC7 intentionally adds optional timeout behavior; the pre-existing no-timeout shell behavior remains asserted unchanged at `packages/pi-better-background-tasks/src/process.test.ts:35` |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) - green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-186.json` -> 1 surface, 0 fail |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> root inventory absent; #186 itself changes no browser route |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | #186 changes no browser route or web-rendered surface |
| Sweep specs do not intercept first-party traffic | lead | N/A | #186 changes no browser route or sweep specification |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | #186 changes no browser or rendered terminal presentation surface |
| When the unit cites a design source (prototype/mockup/design doc): the parity manifest is complete, its citations resolve, and every pinned property holds against the rendered page | gate-lint | N/A | #186 cites no visual design source and changes no browser surface |
| Design source and deliverable rendered side by side at the floor viewports - the check that fails when the parity manifest itself is incomplete | judgment | N/A | #186 cites no visual design source and changes no browser surface |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `ci-audit.mjs --files .github/workflows/ci.yml,.github/workflows/integration-tests.yml,.github/workflows/publish.yml` (exit 1) -> inventory, accounting, sweep, E2E, mock-seam, checklist, evidence-block, quarantine-expiry, smoke, and all-gates are absent; inherited repository adoption gap |
