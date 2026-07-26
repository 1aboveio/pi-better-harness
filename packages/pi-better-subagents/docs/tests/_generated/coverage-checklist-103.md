## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue)._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` cannot inventory this extension: no `coverage.config.json` or repository inventory adapter. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0 without output because this repo has no `coverage.config.json` or inventory adapter; no ownership/floor assertion is available. |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | `git-remotes.ts` (`readGitRemotes`, `syncGitRemotes`) are the only new library surfaces; no CLI/tool/route surface is added. Issue #103 ACs name exactly these two operations for **normal fetch-URL + pushurl topologies**. Class `git-remote-preservation` adjacent members in scope for #103 (multi-url, multi-pushurl with ≥1 fetch URL, fetch-only, multi-remote, whitespace, metachar, stale clear) are covered in `tests/git_remotes.test.mjs`. Push-only remotes (zero `url`, ≥1 `pushurl`) and source-read-failure non-mutation are **accepted deferrals** to #109 — not un-specced #103 gaps. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | Library-only surfaces: `git-remotes.ts` mutates target-repo Git config via real `git remote` / `git config` subprocesses during `syncGitRemotes`; no HTTP route, tool registration, or DB table is introduced. |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-skip --diff 6a8765291961c94b28bf3651808de49a6722edc1` → 0 findings. |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-fixed-timeout --diff 6a8765291961c94b28bf3651808de49a6722edc1` → 0 findings. |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-empty-test --diff 6a8765291961c94b28bf3651808de49a6722edc1` → 0 findings. |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/git_remotes.test.mjs`: multi-url read asserts `urls.length === 2`; multi-url sync asserts both bare mirrors receive `multi-url-proof`; multi-url+pushurl asserts push lands only on push destinations; multi-pushurl dual-destination push; multi-stale url/pushurl clear; metachar url and pushurl clear via unset-all; multi-remote stale removal; fetch-only leftover pushurl clear. |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0 without output because this repo has no `coverage.config.json` or inventory adapter; no level floor can be resolved. Tests self-tag `@level unit` with real `git` integration fixtures. |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | PASS | `tests/git_remotes.test.mjs` uses real `git` subprocesses and temp bare repos; no `page.route`, MSW, or first-party module mock. |
| No mock of a first-party internal seam module (real internals, faked externals) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules mock-internal-seam --diff 6a8765291961c94b28bf3651808de49a6722edc1` and whole-tree equivalent → 0 findings. |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | `tests/git_remotes.test.mjs` imports real `../git-remotes.ts` and shells out to real `git` via `execFileSync`; no money/auth surfaces. |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | Behavioral multi-url push proof at `tests/git_remotes.test.mjs:615-633` requires both fetch URLs to list `multi-url-proof` and stale destinations to stay empty; multi-pushurl proof at `tests/git_remotes.test.mjs` dual-destination branch asserts fail if the second destination is empty. |
| Every new branch / error path has a driving test | lead | PASS | Multi-url read at `tests/git_remotes.test.mjs:226`; multi-url/no-pushurl sync+push at `tests/git_remotes.test.mjs:550`; multi-url+explicit pushurls; multi-pushurl read+sync+push; multi-stale url/pushurl clear via unset-all; metacharacter url and pushurl paths; multi-remote+stale; fetch-only leftover pushurl clear; whitespace URLs — all in `tests/git_remotes.test.mjs`. Descoped error path (source unreadable → abort before target mutation) and push-only remote topology are owned by #109, not claimed here. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | Module introduced on this branch (`git-remotes.ts`). Intended contract is issue #103 ACs + class-complete `git-remote-preservation` (ordered multi-url + multi-pushurl). Prior singular `url` field replaced by `urls: string[]` with RED multi-url tests first. |
| Runtime smoke: each changed non-browser surface was actually run and its happy path responded | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-103.json` → `SMOKE PASS: multi-url/no-pushurl read+sync; push reached both urls` for `git_remotes.read` and `git_remotes.sync`. |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | `git-remotes.ts` is a Node library module; no browser route changed. |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | No browser route changed; see `git-remotes.ts`. |
| Sweep specs do not intercept first-party traffic | lead | N/A | No browser sweep/spec is added by this library-only change. |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | No browser-rendered surface changed. |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/ci-audit.mjs --files .github/workflows/ci.yml` → required inventory, ledger, checklist, evidence, smoke, and presentation gates absent from pre-existing CI configuration. |
