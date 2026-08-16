## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. `coverage-checklist.mjs validate` fails a PASS/FAIL row with no locator, a gate row left TODO, **a cited `file:line` that does not resolve in the tree**, and **a gate row citing its command without the result** — cite the outcome (exit code, `→ N findings`, or the hits), never the command alone._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) -> `docs/tests/_generated/surface-inventory.json` is absent and the repository has no inventory adapter |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | launch, supervision, output draining, and stop are centralized at `packages/pi-better-background-tasks/src/runtime.ts:142`; remote command construction is centralized at `packages/pi-better-background-tasks/src/remote-task-preset.ts:244` |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | #188 changes a Pi extension integration/job seam, not a browser route or HTTP API |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | start/session/log/status behavior is asserted at `packages/pi-better-background-tasks/src/runtime.test.ts:148`; direct/installation/fail-closed/stop/callback branches start at `packages/pi-better-background-tasks/src/runtime.test.ts:205` |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | #188 has no browser traffic interception; SSH is replaced only at the external runner boundary at `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5` |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff f881ce9bf6e264e1ee69d9199a3c9b2bc1586f51` -> 0 findings; `lint-tests.mjs --rules mock-internal-seam` -> 0 findings whole-tree |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | real registry/log/runtime/callback internals execute through the fake external SSH boundary at `packages/pi-better-background-tasks/src/test-support/fake-remote-runner.ts:5` |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | durable metadata, local log bytes, remote calls, callback delivery, and cancellation are asserted beginning at `packages/pi-better-background-tasks/src/runtime.test.ts:148` |
| Every new branch / error path has a driving test | lead | PASS | direct, installed, needs-user, remote stop, success, and failure branches are asserted at `packages/pi-better-background-tasks/src/runtime.test.ts:205` |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | #188 explicitly changes SSH spawn from direct-client behavior to tmux lifecycle; unchanged local process behavior remains covered in `packages/pi-better-background-tasks/src/runtime.test.ts:135` |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-188.json` → 1 surface(s), 0 fail |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | #188 changes no browser route or web-rendered surface |
| Sweep specs do not intercept first-party traffic | lead | N/A | #188 changes no browser route or sweep specification |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | #188 changes no browser or web-rendered surface |
| When the unit cites a design source (prototype/mockup/design doc): the parity manifest is complete, its citations resolve, and every pinned property holds against the rendered page | gate-lint | N/A | #184 and #188 cite no visual design source and change no browser surface |
| Design source and deliverable rendered side by side at the floor viewports — the check that fails when the parity manifest itself is incomplete | judgment | N/A | #184 and #188 cite no visual design source and change no browser surface |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `ci-audit.mjs --files .github/workflows/ci.yml,.github/workflows/integration-tests.yml,.github/workflows/publish.yml` → inventory:absent, accounting:absent, sweep:absent, e2e:absent, mock-seam:absent, checklist:absent, evidence-block:absent, quarantine-expiry:absent, smoke:absent |

