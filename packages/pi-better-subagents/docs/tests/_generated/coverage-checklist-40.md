## Coverage Checklist - issue #40

Scope class: **surface-bearing**. `index.ts` and `sandbox.ts` are unmatched runtime paths; the classifier also marks the changed CI workflow high risk. No browser routes exist.

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | N/A | No repository inventory generator exists; `docs/tests/_generated/surface-inventory.json:40` already enumerates the three changed sandbox extension-library surfaces and `git diff --exit-code 9a30b2f...HEAD -- docs/tests/_generated/surface-inventory.json` is clean. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0; ownership is `docs/tests/issue-39-sandbox-backend-selection.coverage.yml:8`. |
| No un-specced capability missed - the surfaces no AC mentions | judgment | PASS | `sandbox.ts:73` owns discovery, wrapper construction, and policy; `index.ts:294` is the sole spawn caller; `.github/workflows/integration-tests.yml` enables and verifies the Ubuntu bwrap user-namespace prerequisite before executing the real Linux proof. No route, API, event, or additional spawn path changed. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | `docs/tests/_generated/surface-inventory.json:40` declares `sandbox.backend-selection`, `sandbox.command-wrapper`, and `sandbox.spawn-policy` as reachable service reads; `index.ts:386` retains the existing detached-spawn side effect. |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-skip --diff 9a30b2f573a3aef374bdc198045570c4bfea509c` reports 0 findings. |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-fixed-timeout --diff 9a30b2f573a3aef374bdc198045570c4bfea509c` reports 0 findings. |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-empty-test --diff 9a30b2f573a3aef374bdc198045570c4bfea509c` reports 0 findings. |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/sandbox_profile.test.mjs:115` asserts discovery does not execute bwrap; `tests/sandbox_profile.test.mjs:148` asserts default/explicit policy; `tests/sandbox_profile.test.mjs:222` asserts the failing wrapper ran while the direct child did not; `tests/linux_bubblewrap.integration.mjs:19` asserts real confinement outcomes. |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0 with tagged `@level unit` cases in `tests/sandbox_profile.test.mjs:115`; the Linux real-child proof declares `@level integration` at `tests/linux_bubblewrap.integration.mjs:6`. |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | No browser or journey test exists; `tests/sandbox_profile.test.mjs:20` imports real first-party modules and performs no interception. |
| No mock of a first-party internal seam module (real internals, faked externals) - zero-tolerance | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules mock-internal-seam --diff 9a30b2f573a3aef374bdc198045570c4bfea509c` and the whole-tree command both report 0 findings. |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | `tests/sandbox_profile.test.mjs:20` and `tests/linux_bubblewrap.integration.mjs:12` import the real sandbox and spawner; only temporary executable `bwrap` files at the external OS boundary are substituted. |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | `tests/sandbox_profile.test.mjs:124` observes no discovery side effect, `tests/sandbox_profile.test.mjs:252` observes no direct-child marker, and `tests/linux_bubblewrap.integration.mjs:66` checks real inside/outside filesystem results. |
| Every new branch / error path has a driving test | lead | PASS | Absent/non-executable bwrap: `tests/sandbox_profile.test.mjs:132`; explicit/default policy and opt-out: `tests/sandbox_profile.test.mjs:148` and `tests/sandbox_profile.test.mjs:173`; wrapper topology: `tests/sandbox_profile.test.mjs:192`; selected-backend failure: `tests/sandbox_profile.test.mjs:222`; real backend execution: `tests/linux_bubblewrap.integration.mjs:19`. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change - or an intended change is declared with its AC | lead | PASS | The unchanged macOS wrapper/profile remains characterized at `tests/sandbox_profile.test.mjs:82`; Linux support and the Linux-specific unavailable error are declared intended changes by #40 AC1-AC5 and #5's failure matrix, with assertion deltas at `tests/sandbox_profile.test.mjs:115`. |
| Runtime smoke: each changed non-browser surface was actually run | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-40.json` records three passing real-module/spawn commands; the Ubuntu queue reads back the AppArmor user-namespace control and probes the product bwrap topology before running `node --test tests/linux_bubblewrap.integration.mjs` in `.github/workflows/integration-tests.yml`. |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | No browser route exists; `package.json:6` registers a Pi extension only. |
| Presentation sweep ran (runtime gate) | gate-lint | N/A | No browser route or browser surface changed; `sandbox.ts:1` is an extension service module. |
| Sweep specs do not intercept first-party traffic | lead | N/A | No presentation sweep applies because there is no browser route. |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | No browser surface applies. |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | N/A | `ci-audit.mjs --files .github/workflows/ci.yml,.github/workflows/integration-tests.yml` reports the repository has not adopted the full ensure-coverage CI contract; that pre-existing gap is outside #40. The changed workflow passes `actionlint .github/workflows/integration-tests.yml`; it reads back the AppArmor user-namespace setting, probes real bwrap with the product topology, and runs the real Linux test as required commands. |
