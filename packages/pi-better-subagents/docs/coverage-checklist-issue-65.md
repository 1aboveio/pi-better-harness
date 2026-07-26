## Coverage Checklist — issue #65 (orphaned/lost callbacks + diagnostic results)

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows auto-filled by `coverage-checklist.mjs generate` then completed; lead/judgment rows completed by the producer for reviewer adjudication._

Issue: #65. Scope class: `surface-bearing` (`scope-class.mjs classify --stdin` over `6a87652...HEAD` → unmatched runtime paths include `completion.mjs`, `completion.ts`, `index.ts`, `lifecycle.ts`, `registry.ts`, `tools.ts`).

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | PASS | `docs/tests/_generated/surface-inventory.json` — `subagent.health-callback` + `subagent.result` added in this diff; no browser route inventory exists in this pi extension repo |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | `node $EC/coverage-ledger.mjs validate` → 22 surfaces · 22 aligned · 0 Missing/Orphan (ownership via `docs/tests/issue-65-orphaned-lost-callbacks.coverage.yml` for the two new surfaces; existing ownership files cover the rest). The N `Unverified` errors are the repo-wide pre-review attestation state — reviewer promotes after attesting the attached evidence |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | ACs map to health-callback delivery (`completion.mjs` + `index.ts` `deliverHealthCallback`/`reconcileHealth`) and `subagent_result` diagnostics (`lifecycle.ts` + `tools.ts`). Durable markers on `registry.ts` RunMeta are the dedupe substrate for the callback ACs, covered by extension lifecycle tests. No extra surface beyond those. Plan: `docs/plans/issue-65-orphaned-lost-callbacks.md` |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | no HTTP/API routes; local extension tools + pure library seams only |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff 6a87652` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff 6a87652` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff 6a87652` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/health_callback.test.mjs` asserts ATTENTION wording, tool names, wait/stop/retry, followUp options, callback:false null; `tests/health_result_diagnostics.test.mjs` asserts non-final orphaned + terminal-lost bodies with artifacts; `tests/extension_health_lifecycle.test.mjs` describe `#65` drives real health ticks through registered extension wiring (one followUp per transition, durable recovery for persisted unmarked orphaned/lost, failed-handoff retry after reload, dedupe, callback:false keeps notify); AC7/AC8 registered `subagent_result` outcomes updated for best-current/best-available. Command: `node --experimental-strip-types --test tests/health_callback.test.mjs tests/health_result_diagnostics.test.mjs tests/extension_health_lifecycle.test.mjs` |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `@level unit` on `subagent.health-callback` + `subagent.result` — floor `unit` per `docs/tests/issue-65-orphaned-lost-callbacks.coverage.yml`; ledger: 0 Wrong-Level, 22 aligned |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no browser / Playwright tests in diff |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff 6a87652` → 0 findings; whole-tree → 0 findings. Extension tests fake only the OS boundary (`ProcessProbe`) and stub host package `@earendil-works/pi-ai`; never a first-party module |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | host boundary faked via `sendMessage`/`ui.notify` harness + PATH-injected fake `pi`; real extension, registry, completion, lifecycle, tools; child processes are real OS processes where spawn is used |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | assertions target sendMessage customType/options/content, durable meta markers, registered-tool response text (`ATTENTION`, `best-current`, `best-available`, no-throw). Command: `node --test tests/*.test.mjs` |
| Every new branch / error path has a driving test | lead | PASS | `buildHealthCallbackDelivery` callback true/false; orphaned vs lost wording; `deliverHealthCallback` marker short-circuit (pre-marked + multi-tick); persisted unmarked orphaned/lost recovery after reload; failed handoff leaves marker unset and recovers later; `formatOrphanedResult`/`formatLostResult` + registered `subagent_result` paths; completed/failed/killed remain on existing suites |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | Intended #65 AC change: orphaned `subagent_result` now includes best-current artifacts (still non-final); lost uses `formatLostResult` body. Prior non-final/lost-terminal gates retained and strengthened in `tests/extension_health_lifecycle.test.mjs` AC7/AC8. Completion-callback path unchanged (`tests/callback_completion.test.mjs`). Command: `node --test tests/*.test.mjs` |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded | gate-lint | PASS | `node --experimental-strip-types tests/smoke_health_callback.mjs` → SMOKE PASS; results `docs/tests/_generated/runtime-smoke-results-65.json` → 2 surface(s), 0 fail. Adjacent #63 OS smoke still green: `node --experimental-strip-types tests/smoke_health_reconcile.mjs` |

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
| CI wires all required gates and keeps them blocking | gate-lint | N/A | repo has not adopted the full ensure-coverage CI contract (pre-existing); the repo PR gate runs the full unit suite `.github/workflows/ci.yml` (`node --test tests/*.test.mjs`) + macOS sandbox lane |
