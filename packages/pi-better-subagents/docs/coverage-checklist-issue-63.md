## Coverage Checklist — issue #63 (process identity + orphaned/lost reconciliation)

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows auto-filled by `coverage-checklist.mjs generate` then completed; lead/judgment rows completed by the producer for reviewer adjudication._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | PASS | `docs/tests/_generated/surface-inventory.json` — `registry.process-identity` + `health.reconcile` added in this diff; no browser route inventory exists in this pi extension repo |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | `node $EC/coverage-ledger.mjs validate` → 10 surfaces · 10 aligned · 0 Missing/Orphan (ownership via `docs/tests/issue-63-process-identity-reconcile.coverage.yml`); the 10 `Unverified` errors are the repo-wide pre-review attestation state (main carries the same for its 8 surfaces) — reviewer promotes after attesting the attached evidence |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | issue #63 ACs map 1:1 to slices in `docs/plans/issue-63-process-identity-reconcile.md`; the only surface beyond the ACs is the health-ticker lifecycle in `index.ts` (`reconcileHealth`/`ensureHealthTicker`), exercised by the runtime smoke `tests/smoke_health_reconcile.mjs` AND by the extension-level fake-clock lifecycle test `tests/extension_health_lifecycle.test.mjs` (AC9 describe — fix round 1) |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | no HTTP/API routes; local extension tools + pure library seams only (`health.ts`, `registry.ts`) |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff 59a03ce` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff 59a03ce` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff 59a03ce` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/health_reconcile.test.mjs` asserts durable status transitions/patches per case under the process-group-only contract (incl. no-descendants seam + lost-without-group-evidence); `tests/registry_identity.test.mjs` asserts meta.json round-trip + `isFinalResultStatus`/`canExitFinalize` semantics; `tests/extension_health_lifecycle.test.mjs` asserts persisted meta.json outcomes through the real extension (spawn identity, fake-clock ticker lifecycle, exit-supersedes-reconcile interleavings) AND invokes registered `subagent_result`/`subagent_list` tools for orphaned/lost metadata (AC7/AC8 outcome responses, not helper truth tables alone) |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `@level unit` on pure seam + registry metadata — floor `unit` per `docs/tests/issue-63-process-identity-reconcile.coverage.yml`; ledger: 0 Wrong-Level, 10 aligned |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no browser / Playwright tests in diff |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff origin/main` → 0 findings; whole-tree `lint-tests.mjs --rules mock-internal-seam` → 0 findings. Tests fake only the OS boundary (`ProcessProbe` — incl. the injectable spawn-time probe in `tests/extension_health_lifecycle.test.mjs`) and stub the pi host package `@earendil-works/pi-ai` (external, not installed in-repo); never a first-party module |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | fakes are hand-rolled `ProcessProbe` objects (`tests/health_reconcile.test.mjs` `makeProbe`, `tests/extension_health_lifecycle.test.mjs` `fakeSpawnIdentityProbe`) substituting kernel process state — the definition of an external fake; real probe covered against the kernel by `tests/smoke_health_reconcile.mjs`; child processes in extension-level tests are real OS processes (fake `pi` shell scripts on PATH) |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | assertions target durable statuses/patches/persisted meta.json and registered-tool response text (`assert.equal(r.status, "orphaned")`, `meta.pgid === pid`, `readMeta(id).status === "completed"`, `subagent_result` orphaned/lost body matches, process-group-only seam asserts); command: `node --test tests/*.test.mjs` |
| Every new branch / error path has a driving test | lead | PASS | `tests/health_reconcile.test.mjs` covers every `reconcileRun` reason under process-group-only (`orphaned-group-alive`, no `orphaned-descendants-alive`); fix round 1 added: `canExitFinalize` truth table, exit-supersedes-provisional interleavings + AC1 persistence + AC9 ticker lifecycle, independent probe-capability cases; fix round 2 added AC7/AC8 outcome evidence via registered tools; fix round 3 added process-group-only seam + behavior tests proving escaped/reparented descendants are out of contract |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | intended changes declared: (1) issue #63 ACs 7–8 (`orphaned` non-final / `lost` terminal in `subagent_result`), OUTCOME-TESTED via registered tools; (2) fix round 1 terminal-exit-dominates-health-reconcile — `canExitFinalize` + interleave tests; (3) fix round 3 accepted design re-entry (ADR 0002): process-group-only — descendant evidence removed entirely; tests no longer expect orphaned-from-descendants; absence of group evidence → lost. Command: `node --test tests/*.test.mjs` |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded | gate-lint | PASS | `node tests/smoke_health_reconcile.mjs` → SMOKE PASS (real OS processes: supervised→orphaned→durable→lost); results `docs/tests/_generated/runtime-smoke-results-63.json` |

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
| CI wires all required gates and keeps them blocking | gate-lint | N/A | repo has not adopted the full ensure-coverage CI contract (pre-existing — `ci-audit.mjs` findings predate this diff); the repo PR gate runs the full unit suite `.github/workflows/ci.yml` (`node --test tests/*.test.mjs`) + macOS sandbox lane, and the queue gate runs integration tests |
