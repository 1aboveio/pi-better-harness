## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. `coverage-checklist.mjs validate` fails a PASS/FAIL row with no locator, a gate row left TODO, **a cited `file:line` that does not resolve in the tree**, and **a gate row citing its command without the result** — cite the outcome (exit code, `→ N findings`, or the hits), never the command alone._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `coverage-ledger.mjs validate` -> exit 2: `docs/tests/_generated/surface-inventory.json` is absent and the repository has no root inventory adapter |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `coverage-ledger.mjs validate` -> exit 2 before reconciliation because the root inventory is absent |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | resume reconstruction is centralized at `packages/pi-better-background-tasks/src/runtime.ts:373`, timeout outcomes at `packages/pi-better-background-tasks/src/runtime.ts:635`, and launch/status copy at `packages/pi-better-background-tasks/src/tools.ts:291`; #189 ACs cover each changed contract |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | #189 changes a Pi extension integration/runtime and package docs, not a browser route, HTTP API, table, or permission surface; public tool registration begins at `packages/pi-better-background-tasks/src/tools.ts:101` |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-skip,no-fixed-timeout,no-empty-test,mock-internal-seam --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> no violations introduced |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | resume state, fake runner calls, no duplicate create, timeout status/result, docs, and verbose metadata are asserted beginning at `packages/pi-better-background-tasks/src/runtime.test.ts:337` and `packages/pi-better-background-tasks/src/e2e.test.ts:107` |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `coverage-ledger.mjs validate` -> exit 2 before tagged integration evidence can be reconciled because the root inventory is absent |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no browser/HTTP interception is present; only the external SSH process is faked by `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5` |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | PR lane `lint-tests.mjs --rules no-skip,no-fixed-timeout,no-empty-test,mock-internal-seam --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> no violations introduced; whole tree `lint-tests.mjs --rules mock-internal-seam` -> no violations in scanned test files |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | real runtime scheduling, registry persistence, condition evaluation, logs, callbacks, and timeout finalization execute behind the external fake runner at `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5` |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | terminal durable state and external command effects are asserted by the resume/timeout tests at `packages/pi-better-background-tasks/src/runtime.test.ts:337`; this package exposes no browser page |
| Every new branch / error path has a driving test | lead | PASS | resume tmux/watch and timeout tmux/watch/direct branches are driven at `packages/pi-better-background-tasks/src/runtime.test.ts:337`; stacked bootstrap/watch/spawn failure matrices remain in the same suite |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | local watch behavior is pinned by `@characterizes background-task.local-watch` at `packages/pi-better-background-tasks/src/runtime.test.ts:53`; SSH resume/timeout/tool changes are declared intended behavior in #189 with assertion deltas in this diff |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-189.json` → 3 surface(s), 0 fail |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | #189 changes no browser route; public output is terminal/tool text asserted at `packages/pi-better-background-tasks/src/e2e.test.ts:107` |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | #189 changes no browser route or web-rendered surface; runtime smoke is recorded in `docs/tests/_generated/runtime-smoke-results-189.json:1` |
| Sweep specs do not intercept first-party traffic | lead | N/A | #189 adds no presentation sweep or browser traffic interception; the external SSH fake is at `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5` |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | #189 changes terminal/tool copy only; compact and verbose support metadata are asserted at `packages/pi-better-background-tasks/src/e2e.test.ts:206` |
| When the unit cites a design source (prototype/mockup/design doc): the parity manifest is complete, its citations resolve, and every pinned property holds against the rendered page | gate-lint | N/A | #184 is a non-visual lifecycle design and #189 changes no browser presentation surface |
| Design source and deliverable rendered side by side at the floor viewports — the check that fails when the parity manifest itself is incomplete | judgment | N/A | #184 and #189 cite no visual design source and have no browser deliverable |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `ci-audit.mjs --files .github/workflows/ci.yml,.github/workflows/integration-tests.yml,.github/workflows/publish.yml` → inventory:absent, accounting:absent, sweep:absent, e2e:absent, mock-seam:absent, checklist:absent, evidence-block:absent, quarantine-expiry:absent, smoke:absent |

