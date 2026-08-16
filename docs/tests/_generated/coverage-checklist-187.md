## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. `coverage-checklist.mjs validate` fails a PASS/FAIL row with no locator, a gate row left TODO, **a cited `file:line` that does not resolve in the tree**, and **a gate row citing its command without the result** — cite the outcome (exit code, `→ N findings`, or the hits), never the command alone._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> `docs/tests/_generated/surface-inventory.json` is absent on this branch and merge-base `f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51`; no inventory generator is configured |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> root surface inventory is absent; implementation evidence remains tagged at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:75`, `packages/pi-better-background-tasks/src/runtime.test.ts:71`, and `packages/pi-better-background-tasks/src/e2e.test.ts:60` |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | public SSH/watch schemas are centralized at `packages/pi-better-background-tasks/src/tools.ts:19`; runtime expansion is centralized at `packages/pi-better-background-tasks/src/runtime.ts:141`; status/navigator identity remains covered at `packages/pi-better-background-tasks/src/e2e.test.ts:143` |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | #187 and stacked #185 change Pi extension tool/runtime surfaces, not browser routes, HTTP APIs, forms, or database mutations |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | direct normalization is asserted at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:75`; condition/status/log outcomes at `packages/pi-better-background-tasks/src/runtime.test.ts:115` and `packages/pi-better-background-tasks/src/runtime.test.ts:138`; public contract at `packages/pi-better-background-tasks/src/e2e.test.ts:88` |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> root inventory absent, so tagged unit/integration evidence cannot be mechanically graded |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | #187 has no browser or first-party network interception; only the external SSH process boundary is faked at `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5` |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> no violations introduced; `lint-tests.mjs --rules mock-internal-seam` -> no violations whole-tree |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | the external SSH process is replaced by the fake at `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5`; real scheduling, registry, condition evaluation, logging, and callback code execute through `packages/pi-better-background-tasks/src/runtime.ts:141` |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | terminal state and operator-readable transport outcomes are asserted at `packages/pi-better-background-tasks/src/runtime.test.ts:171` and `packages/pi-better-background-tasks/src/runtime.test.ts:201`; per-poll durable output at `packages/pi-better-background-tasks/src/runtime.test.ts:138` |
| Every new branch / error path has a driving test | lead | PASS | direct/tmux normalization branch at `packages/pi-better-background-tasks/src/remote-task-preset.test.ts:75`; all condition families at `packages/pi-better-background-tasks/src/runtime.test.ts:115`; exit-255 and runner rejection at `packages/pi-better-background-tasks/src/runtime.test.ts:171` and `packages/pi-better-background-tasks/src/runtime.test.ts:201`; lifecycle terminals/cancel at `packages/pi-better-background-tasks/src/runtime.test.ts:262` and `packages/pi-better-background-tasks/src/runtime.test.ts:307` |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | #184/#187 declare the SSH behavior changes; unchanged local watch success/failure/timeout is explicitly characterized from `packages/pi-better-background-tasks/src/runtime.test.ts:52`; stacked #185 target-label behavior is asserted at `packages/pi-better-background-tasks/src/e2e.test.ts:143` |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-187.json` → 4 surface(s), 0 fail |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | #187 and stacked #185 change no browser route or web-rendered surface; terminal/model-facing surfaces are exercised by `packages/pi-better-background-tasks/src/e2e.test.ts:60` |
| Sweep specs do not intercept first-party traffic | lead | N/A | #187 changes no browser route or presentation sweep; the fake SSH boundary is documented at `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5` |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | #187 changes terminal/tool descriptions only; direct-watch guidance is asserted through the registered tool contract at `packages/pi-better-background-tasks/src/e2e.test.ts:88` |
| When the unit cites a design source (prototype/mockup/design doc): the parity manifest is complete, its citations resolve, and every pinned property holds against the rendered page | gate-lint | N/A | #187 cites no visual design source and changes no browser surface |
| Design source and deliverable rendered side by side at the floor viewports — the check that fails when the parity manifest itself is incomplete | judgment | N/A | #187 cites no visual design source and changes no browser surface |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `ci-audit.mjs --files .github/workflows/ci.yml,.github/workflows/integration-tests.yml,.github/workflows/publish.yml` → inventory:absent, accounting:absent, sweep:absent, e2e:absent, mock-seam:absent, checklist:absent, evidence-block:absent, quarantine-expiry:absent, smoke:absent |

