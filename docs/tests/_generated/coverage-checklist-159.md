## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. `coverage-checklist.mjs validate` fails a PASS/FAIL row with no locator, a gate row left TODO, **a cited `file:line` that does not resolve in the tree**, and **a gate row citing its command without the result** — cite the outcome (exit code, `→ N findings`, or the hits), never the command alone._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) → root `docs/tests/_generated/surface-inventory.json` absent and no repository inventory generator is configured; inherited repository gap |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) → root surface inventory absent; proving tests are tagged at `packages/callback-batcher/index.test.ts:1` and extension integrations at `packages/pi-better-background-tasks/src/runtime.test.ts:146` / `packages/pi-better-subagents/tests/extension_health_lifecycle.test.mjs:351` |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | shared ordinary/urgent API is bounded at `packages/callback-batcher/index.ts:78` and `packages/callback-batcher/index.ts:200`; both production consumers are exercised by `packages/callback-batcher/integration.test.ts:13` |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | #159 changes internal callback events only; no route or API reachability/mutation surface |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff b56092520e11f025dbc4a5c0c701151649d4898f` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff b56092520e11f025dbc4a5c0c701151649d4898f` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff b56092520e11f025dbc4a5c0c701151649d4898f` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | stable aggregation and timers at `packages/callback-batcher/index.test.ts:42`; failure/concurrency at `packages/callback-batcher/index.test.ts:104`; production recovery at `packages/pi-better-subagents/tests/extension_health_lifecycle.test.mjs:400` |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) → root surface inventory absent, so tagged unit/integration evidence cannot be graded; inherited repository gap |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | #159 changes no browser journey and tests use no traffic interception |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff b56092520e11f025dbc4a5c0c701151649d4898f` → 0 findings; `lint-tests.mjs --rules mock-internal-seam` → 0 findings whole-tree |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | shared logic runs real with only the Pi host handoff boundary substituted at `packages/callback-batcher/index.test.ts:29`; extension tests execute real registries/finalizers at `packages/pi-better-subagents/tests/extension_health_lifecycle.test.mjs:400` |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | delivered aggregate, durable markers, payload exclusion, retry, and suppression are asserted at `packages/pi-better-background-tasks/src/runtime.test.ts:149` and `packages/pi-better-subagents/tests/extension_health_lifecycle.test.mjs:354` |
| Every new branch / error path has a driving test | lead | PASS | send failure/concurrent arrival at `packages/callback-batcher/index.test.ts:104`, suppression/callback:false at `packages/callback-batcher/index.test.ts:137`, urgent failure/retry at `packages/callback-batcher/index.test.ts:163` |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | #159 explicitly changes one-message-per-completion to batching and callback:false to no follow-up; pre-change callback characterization passed before edits and intended deltas are asserted at `packages/pi-better-background-tasks/src/runtime.test.ts:149` / `packages/pi-better-subagents/tests/extension_health_lifecycle.test.mjs:354` |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-159.json` → 4 surface(s), 0 fail |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 2) |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | #159 changes no browser route or rendered surface |
| Sweep specs do not intercept first-party traffic | lead | N/A | #159 changes no browser route or sweep specification |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | #159 changes model follow-up event delivery only, with no rendered browser surface |
| When the unit cites a design source (prototype/mockup/design doc): the parity manifest is complete, its citations resolve, and every pinned property holds against the rendered page | gate-lint | N/A | #159 cites no visual design source and changes no browser surface |
| Design source and deliverable rendered side by side at the floor viewports — the check that fails when the parity manifest itself is incomplete | judgment | N/A | #159 cites no visual design source and changes no browser surface |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `ci-audit.mjs --files .github/workflows/ci.yml,.github/workflows/integration-tests.yml,.github/workflows/publish.yml` → inventory:absent, accounting:absent, sweep:absent, e2e:absent, mock-seam:absent, checklist:absent, evidence-block:absent, quarantine-expiry:absent, smoke:absent |
