## Coverage Checklist — issue #66 (multi-dimensional health observations)

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows auto-filled by `coverage-checklist.mjs generate` then completed; lead/judgment rows completed by the producer for reviewer adjudication._

Scope class: **surface-bearing** (`health-observation.ts`, `health.ts`, `config.ts`). No browser routes.

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | PASS | `docs/tests/_generated/surface-inventory.json` — `health.observation` + `health.event-facts` added in this diff; no browser route inventory exists in this pi extension repo |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | ownership via `docs/tests/issue-66-health-observations.coverage.yml` (`health.observation`, `health.event-facts`, floor `unit`); proving tests `tests/health_observation.test.mjs` tagged `// @covers health.observation` + `// @covers health.event-facts` `@level unit`; residual `Unverified` attestation is pre-review state awaiting reviewer promotion (same class as #63) |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | issue #66 ACs map to pure observation + event-fact extraction in `health-observation.ts`; config threshold keys on `config.ts` are optional loaders only; no list/navigator/callback wiring (#67/#65/#69 out of scope). Slice map: `docs/plans/issue-66-health-observations.md` |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | `health-observation.ts` is a pure read/compute library seam (no durable writes); `health.ts` re-exports only; `config.ts` adds optional threshold fields — no HTTP/API routes |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff origin/main` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff origin/main` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/health_observation.test.mjs` asserts activity residual stale, compaction/tool/model dimensions, raw-log diagnostic separation, threshold overrides, orphaned process liveness, and #64 fixture parsing (`assert.equal(obs.activity, "stale")`, `assert.equal(obs.compaction.state, "long_compacting")`, `assert.notEqual(obs.activity, "stale")`, history retained after recovery) |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `@level unit` on pure observation + event-facts — floor `unit` per `docs/tests/issue-66-health-observations.coverage.yml` |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no browser / Playwright tests in diff |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff origin/main` → 0 findings; whole-tree `lint-tests.mjs --rules mock-internal-seam` → 0 findings. Tests pass in-memory event arrays and thresholds; filesystem used only for real log fixtures under the real registry path |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | no mocks; event streams are test data (external child-log boundary). Real #64 fixtures under `docs/evidence/issue-64/fixtures/` exercised |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | assertions target observation fields (`activity`, `compaction.state`, `tool.state`, `model.listWarning`, `compactFacts`, `rawLog`); command: `node --experimental-strip-types --test tests/health_observation.test.mjs` |
| Every new branch / error path has a driving test | lead | PASS | quiet→stale, compaction-not-stale, long-compaction, tool-running, long-tool, model-error recovery, fatal+failed compatibility, raw-log-noise, long_model_call unsupported, configurable thresholds, orphaned process dimension, fixture parse paths in `tests/health_observation.test.mjs` |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | intended additive behavior declared by issue #66 ACs + plan; `reconcileRun` process-group contract unchanged (existing `tests/health_reconcile.test.mjs` still green). No durable status transition logic altered |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded | gate-lint | PASS | `node --experimental-strip-types tests/smoke_health_observation.mjs` → SMOKE PASS; results `docs/tests/_generated/runtime-smoke-results-66.json` → 2 surface(s), 0 fail |

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
| CI wires all required gates and keeps them blocking | gate-lint | N/A | repo has not adopted the full ensure-coverage CI contract (pre-existing — `.github/workflows/ci.yml` runs `node --test tests/*.test.mjs`); new unit tests are included in that job |
