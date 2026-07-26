## Coverage Checklist - issue #39

Scope class: **surface-bearing** (`sandbox.ts` is a changed extension service). No browser routes.

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | N/A | No repository inventory generator exists; the repository's hand-maintained `docs/tests/_generated/surface-inventory.json:1` now lists all three #39 extension-library surfaces. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0; ownership is `docs/tests/issue-39-sandbox-backend-selection.coverage.yml:6`. |
| No un-specced capability missed - the surfaces no AC mentions | judgment | PASS | `sandbox.ts:16` contains backend selection and `index.ts:294` remains the sole spawn policy; no new route, API, event, job, or detached-spawn path exists. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | `docs/tests/_generated/surface-inventory.json:40` declares the three surfaces as reachable `service` reads; they do not mutate durable state. |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-skip --diff origin/main` reports 0 findings. |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-fixed-timeout --diff origin/main` reports 0 findings. |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-empty-test --diff origin/main` reports 0 findings. |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/sandbox_profile.test.mjs:16` asserts the existing support query, `tests/sandbox_profile.test.mjs:28` asserts every caller policy state, and `tests/sandbox_profile.test.mjs:41` asserts ordered wrapper argv plus SBPL output. |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0 with `@level unit` at `tests/sandbox_profile.test.mjs:16`. |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | No browser or journey test exists; `tests/sandbox_profile.test.mjs:1` imports the real sandbox module and has no interception. |
| No mock of a first-party internal seam module | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules mock-internal-seam --diff origin/main` and the whole-tree command both report 0 findings. |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | `tests/sandbox_profile.test.mjs:12` imports the real first-party module; no mocks are used. |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | `tests/sandbox_profile.test.mjs:41` checks the wrapper's executable, exact ordered argv, and written SBPL allowances; it does not assert a rendered page. |
| Every new branch / error path has a driving test | lead | PASS | `tests/sandbox_profile.test.mjs:16` drives the selected macOS backend on this host; the existing non-Darwin assertion is driven on the Linux PR runner. The selector has no error path and no caller branch changed. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change - or an intended change is declared with its AC | lead | PASS | `tests/sandbox_profile.test.mjs:15`, `tests/sandbox_profile.test.mjs:27`, and `tests/sandbox_profile.test.mjs:40` carry `@characterizes`; the pre-refactor focused suite passed before `sandbox.ts` was edited. |
| Runtime smoke: each changed non-browser surface was actually run | gate-lint | PASS | `node --test tests/sandbox_profile.test.mjs` passes 3/3 and `node --experimental-strip-types --check sandbox.ts` exits 0. |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | No browser routes: `package.json:6` registers only a Pi extension. |
| Presentation sweep ran (runtime gate) | gate-lint | N/A | No browser route or browser surface changed; `sandbox.ts:1` is an extension service module. |
| Sweep specs do not intercept first-party traffic | lead | N/A | No presentation sweep applies because there is no browser route. |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | No browser surface applies. |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | N/A | `ci-audit.mjs --files .github/workflows/ci.yml` reports this repository has not adopted the full ensure-coverage CI contract; #39 does not modify CI. Existing `.github/workflows/ci.yml:36` runs `node --test tests/*.test.mjs`. |
