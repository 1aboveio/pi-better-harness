## Coverage Checklist — issue #68 (orphaned stop / close cleanup)

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows auto-filled by tools then completed; lead/judgment rows completed by the producer for reviewer adjudication._

Issue: #68. Scope class: `surface-bearing` (changed runtime paths: `stop.ts`, `navigator.mjs`, `tools.ts`). No browser routes.

Base: `origin/main` @ `4cf18c7`. ADR: `docs/adr/0002-process-group-only-subagent-health.md` — related work is process-group only; escaped descendants are out of contract.

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | PASS | `docs/tests/_generated/surface-inventory.json` — `stop.orphaned-cleanup` added; `navigator.close` already owned and extended. No browser route inventory in this pi extension repo |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | ownership via `docs/tests/issue-68-orphaned-close.coverage.yml`; proving tests `tests/orphaned_stop.test.mjs` tagged `@covers stop.orphaned-cleanup` / `navigator.close` `@level unit`. Residual Unverified attestation is pre-review state |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | ACs map to shared `stopRun` orphaned cleanup + TUI Close integration. Plan: `docs/plans/issue-68-orphaned-close.md`. No restart UX, no navigator health (#69), no descendant-tree crawl (ADR 0002) |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | `stop.orphaned-cleanup`=mutation (SIGTERM + durable status write); `navigator.close`=mutation (stop then dismiss). Local extension seams; no HTTP/API routes |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `node $EC/lint-tests.mjs --rules no-skip --diff origin/main` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `node $EC/lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings (`waitFor` is bounded predicate poll) |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `node $EC/lint-tests.mjs --rules no-empty-test --diff origin/main` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/orphaned_stop.test.mjs` — 21 tests assert StopOutcome, durable meta status/lifecycle/endedAt, OS process-group liveness, Close dismiss ordering, tool reply text. Command: `node --experimental-strip-types --test tests/orphaned_stop.test.mjs` → 21/21 pass |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `@level unit` matches `requiredLevels: [unit]` in `docs/tests/issue-68-orphaned-close.coverage.yml` |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no browser / Playwright tests |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance | gate-lint | PASS | `node $EC/lint-tests.mjs --rules mock-internal-seam --diff origin/main` → 0 findings; whole-tree → 0 findings. Real `stopRun` / registry / navigator; fake only OS `ProcessProbe` and inert Type schema stub |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | process-group liveness faked only in pure finalize branches; live-group kill paths use real detached `sleep` process groups |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | asserts durable disk status, process death, Close dismiss timestamp ordering, tool text. Command: `node --experimental-strip-types --test tests/orphaned_stop.test.mjs tests/navigator_close.test.mjs tests/navigator_dismissal.test.mjs` → 58/58 pass |
| Every new branch / error path has a driving test | lead | PASS | scan-diff leads adjudicated: running/orphaned/not-running branches; groupAlive kill vs finalize; completed/failed/lost log branches; Close stoppable branch + not-closed hold; tool finalized reply. Command: `git diff origin/main -- stop.ts navigator.mjs tools.ts tests/orphaned_stop.test.mjs \| node $RP/scan-diff.mjs` → findings `[]` |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | Intended #68 AC changes: (1) orphaned accepted by stop; (2) Close treats orphaned as stoppable; (3) stop tool reports Resolved on finalize. Prior running stop+kill+dismiss pinned by compatibility suite + existing `tests/navigator_close.test.mjs` / `tests/navigator_dismissal.test.mjs` (still green) |
| Runtime smoke: each changed non-browser surface was actually run via the repo run command and its happy path responded | gate-lint | PASS | `node --experimental-strip-types tests/smoke_orphaned_stop.mjs` → SMOKE PASS 15/15; results `docs/tests/_generated/runtime-smoke-results-68.json` |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | no browser routes |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | no browser routes |
| Sweep specs do not intercept first-party traffic | lead | N/A | no browser routes |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | no browser routes |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | N/A | repo PR gate is type-strip + `node --test tests/*.test.mjs` (`.github/workflows/ci.yml`); full ensure-coverage CI contract not adopted (pre-existing; precedent #65/#67) |

### ADR / contract note (reviewer)

Issue #68 AC text says "process-group members or descendants". ADR 0002 forbids descendant-tree tracking of escaped/reparented processes. Implementation keeps ADR 0002: related work = captured process group only. Tests cover group-mates still inside the group (bash leader + background sleep) and explicitly do **not** claim escaped-descendant cleanup. See `docs/plans/issue-68-orphaned-close.md`.
