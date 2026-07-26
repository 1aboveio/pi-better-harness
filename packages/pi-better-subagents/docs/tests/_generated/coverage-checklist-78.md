## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. A PASS/FAIL row with no evidence locator, or a gate row left TODO, fails `coverage-checklist.mjs validate`._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | N/A | No repository inventory generator exists; `docs/tests/_generated/surface-inventory.json` is not maintained for this extension-only repo. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | `coverage-ledger.mjs validate --warn-only` (exit 0) — pre-existing Unverified surfaces (widget.*, sandbox.*) are outside #78; changed runtime paths in `git-workspace.ts` and `index.ts` are exercised by added tests including live tool execute. |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | New/changed surfaces: `git-workspace.ts` (clone prep + inspection + remote preservation via structured config), `index.ts:subagent_spawn.git_clone_workspace` parameter, `batch.mjs:mergeJobOptions` forwarding `git_clone_workspace` for batch same-semantics. Covered by `tests/git_workspace.test.mjs`, `tests/git_clone_workspace_wiring.test.mjs`, `tests/subagent_spawn_batch.test.mjs`, and live `tests/git_clone_workspace_live.test.mjs`. No routes, APIs, events, or jobs added. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | `subagent_spawn` is an existing tool surface; `git_clone_workspace` is a new write-path option on the same tool. No reachability change. Tests exercise both opt-in and opt-out. |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff ce8e8a212908f09aa87bdfe6e784552882f9baa1` → 0 findings. Git suite fails hard when `git` is absent (no `describe(..., { skip })`). |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff ce8e8a212908f09aa87bdfe6e784552882f9baa1` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff ce8e8a212908f09aa87bdfe6e784552882f9baa1` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/git_workspace.test.mjs` asserts branch name + commit (incl. explicit named-branch symbolic checkout), remote preservation class-complete (whitespace local paths via structured `git config --null`, multi-remote + stale remote removal, fetch-only, distinct `remote.origin.pushurl`, push lands on configured push remote), `--reference-if-able` argv + unavailable-reference fallback, real rebase conflict + `rebase --continue`, product sandbox wrapper Git ops + outside-write denial, linked-worktree fail-fast message, identity preservation. `tests/subagent_spawn_batch.test.mjs` proves `mergeJobOptions` forwards `git_clone_workspace` from shared and per-job inputs. `tests/git_clone_workspace_live.test.mjs` invokes registered `subagent_spawn.execute` (happy path + broken linked-worktree fail-fast with spawn-marker not reached). |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `coverage-ledger.mjs validate --warn-only` (exit 0). Changed surfaces covered by unit/integration tests at appropriate floors. |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | No browser/journey tests added; no `page.route`/`route.fulfill`/MSW usage. |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff ce8e8a212908f09aa87bdfe6e784552882f9baa1` → 0 findings; `lint-tests.mjs --rules mock-internal-seam` whole-tree → 0 findings. Real `git` CLI + real `maybeBuildSandboxCommand`; ExtensionAPI harness only stubs the host API surface. |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | No mocks of first-party internals; real `git` and product sandbox wrapper. Live tool path uses a stub `pi` binary only as the external child process. No money/auth/idempotency surfaces touched. |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | Tests assert real git state (`.git` directory, branch name, remote URL, push side-effects, rebase conflict status, sandbox outside-write denial). No browser surfaces. |
| Every new branch / error path has a driving test | lead | PASS | `tests/git_workspace.test.mjs` covers linked-worktree fail-fast (`assertSafeGitWorkspace` + broken commonGitDir), non-git source error, remote preservation class (whitespace URLs, multi-remote, stale removal, fetch-only, distinct pushurl), explicit named-branch symbolic checkout, unavailable-reference fallback, rebase conflict + `--continue`, product sandbox outside-write denial, identity preservation; `tests/subagent_spawn_batch.test.mjs` covers batch shared/per-job `git_clone_workspace` option forwarding; `tests/git_clone_workspace_live.test.mjs` covers live `subagent_spawn.execute` happy path and broken linked-worktree rejection without child spawn. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | `index.ts` change is additive: only affects behavior when `git_clone_workspace:true` is passed; default/legacy paths unchanged. Existing tests still pass. Intended change declared in issue #78 ACs. |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-78.json` → 3 surface(s), 0 fail. Live tool execute via ExtensionAPI harness + git-workspace library ops + batch mergeJobOptions forwarding. |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | No browser routes changed or added. |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | No browser surfaces. |
| Sweep specs do not intercept first-party traffic | lead | N/A | No browser/presentation tests. |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | No browser surfaces. |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | N/A | `ci-audit.mjs --files .github/workflows/ci.yml` reports the repository has not adopted the full ensure-coverage CI contract; that pre-existing gap is outside #78. The changed code is covered by the existing `node --test tests/*.test.mjs` gate in `.github/workflows/ci.yml`. |
