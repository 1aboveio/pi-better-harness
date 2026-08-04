## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. `coverage-checklist.mjs validate` fails a PASS/FAIL row with no locator, a gate row left TODO, **a cited `file:line` that does not resolve in the tree**, and **a gate row citing its command without the result** — cite the outcome (exit code, `→ N findings`, or the hits), never the command alone._

Unit: #150 · base `194079b` · head `2ed2bb5947b298e2398fd6d896660a3e08e6bfa5`

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | no gen-inventory adapter in this extension repo (`../../scripts/` has none) — pre-existing repo gap (same as #109). This diff adds no surfaces: `git diff --name-only 194079b...HEAD` → `completion.mjs`, `finalization.ts`, two test files, one plan doc; `docs/tests/_generated/surface-inventory.json` untouched, so no drift. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 1) — 31 surfaces · 31 aligned · 0/31 tested surfaces over-mocked (0%) · 31 errors · 0 warnings. All 31 are inherited `Unverified` attestation gaps on pre-existing surfaces (widget/sandbox/registry/health/navigator/stop/tools/subagent.*); the changed seams (`completion.mjs` formatter, `finalization.ts` delivery) are not inventory surfaces and the diff touches no curated `*.coverage.yml`. Pre-existing debt, not introduced here. Proving tests self-tag `tests/run_finalization.test.mjs:1-8` (`@covers subagent.run-finalization`, `@level unit`/`integration`). |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | Issue #150 ACs name exactly the callback-content change. Only the completion formatter (`completion.mjs:28`) and the finalization call site (`finalization.ts:72`) change; `subagent_result` rendering (`buildSubagentResultText`), navigator, and log surfaces are untouched and remain the detailed-evidence path, as the ACs require. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | Library formatter seams only: `formatCallbackTrigger`/`buildCompletionDelivery` return strings/objects; `finalizeRun` keeps its existing meta mutation (`finalization.ts:60-66`) unchanged. No HTTP route, tool registration, DB table, or event surface added. |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff 194079b` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff 194079b` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff 194079b` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/callback_completion.test.mjs` `includes outcome metadata but omits the execution trace` builds a 100-entry alternating trace and asserts label/verdict/stat retained plus `doesNotMatch(/read|bash|tools:/)`; `callback:true preserves outcome metadata while omitting tool history` asserts delivery content end-to-end; `tests/run_finalization.test.mjs` complete-exit test asserts the delivered callback content `doesNotMatch(/read|tools:/i)` after a real `finalizeRun`. |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 1) — same inherited 31 `Unverified` attestation gaps as the breadth row; the changed seams are not inventory surfaces, so no floor applies. Self-tagged `@level unit` (formatter) / `@level integration` (finalizeRun delivery) in `tests/callback_completion.test.mjs` and `tests/run_finalization.test.mjs` are appropriate for library seams. Pre-existing. |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no browser / Playwright tests in the diff; `git diff --name-only 194079b...HEAD` → no spec files. |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff 194079b` → 0 findings (PR lane); `lint-tests.mjs --rules mock-internal-seam` → 0 findings (whole tree) |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | no `vi.mock`/`jest.mock` anywhere in the diff; `tests/run_finalization.test.mjs` drives the real `finalizeRun` against real temp run dirs (`tests/run_finalization.test.mjs:233-275`). No money/auth/idempotency surface. |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | assertions target delivered message content and durable result text (`tests/run_finalization.test.mjs:262-271`), not DOM/HTTP status; negative assertions (`doesNotMatch`) are paired with positive metadata assertions so an empty message cannot pass. |
| Every new branch / error path has a driving test | lead | PASS | the diff removes a branch (tools append) and adds none; trace omission is driven for completed (`tests/callback_completion.test.mjs` `includes outcome metadata but omits the execution trace`), delivery (`callback:true preserves outcome metadata while omitting tool history`), and the real finalization path (`tests/run_finalization.test.mjs:265`). Failed/incomplete wording branches remain pinned by the pre-existing `formatCallbackTrigger`/`formatCallbackQuiet` suites. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | intended change declared in issue #150 ACs (omit tool-call trace; retain metadata + handoff). Preserved behavior is pinned by the existing callback suites (completed/failed/incomplete wording, quiet path, no-result-embedding) which stayed green, and by RED-first evidence: the three updated assertions failed before the code change and pass after. |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-150.json` → 2 surface(s), 0 fail (`node --experimental-strip-types docs/tests/issue-150-runtime-smoke.mjs`: formatter with a 200-entry trace; real `finalizeRun` delivery with a 120-event trace) |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | no browser routes in this extension; `git diff --name-only 194079b...HEAD` → formatter/finalization/tests/docs only. (The generator's ledger-derived FAIL here reflects the same inherited attestation debt, not a browser surface.) |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | no browser routes |
| Sweep specs do not intercept first-party traffic | lead | N/A | no browser routes |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | no browser routes |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `ci-audit.mjs --files ../../.github/workflows/ci.yml` → inventory:absent, accounting:absent, sweep:absent, e2e:absent, mock-seam:absent, checklist:absent, evidence-block:absent, quarantine-expiry:absent, smoke:absent — pre-existing repo gap (CI runs unit tests only), not introduced by this PR. |
