## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue)._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` cannot inventory this extension: no `coverage.config.json` or repository inventory adapter. Pre-existing repo gap (same as #103). Surfaces under test are the existing library pair `git_remotes.read` / `git_remotes.sync` in `git-remotes.ts`. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `coverage-ledger.mjs validate` exits 0 without output because this repo has no `coverage.config.json` or inventory adapter; no ownership/floor assertion is available. Pre-existing. Proving tests self-tag `@covers git_remotes.read` / `@covers git_remotes.sync` `@level unit` with real `git` fixtures in `tests/git_remotes.test.mjs`. |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | Only `git-remotes.ts` library surfaces change (`readGitRemotes`, `syncGitRemotes`). No CLI/tool/route/sandbox/merge-queue surface is added. Issue #109 ACs name exactly push-only remote topology + source-read-failure non-mutation on those two operations. #103 normal topologies stay covered by the existing suite in `tests/git_remotes.test.mjs`. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | Library-only: `syncGitRemotes` mutates target-repo Git config via real `git remote` / `git config` subprocesses; `readGitRemotes` is read-only. No HTTP route, tool registration, or DB table is introduced. Source-read failure path is intentionally non-mutating (`git-remotes.ts` `syncGitRemotes` reads source before any target write). |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-skip --diff origin/main` → 0 findings. |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings. |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-empty-test --diff origin/main` → 0 findings. |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/git_remotes.test.mjs`: push-only read asserts `origin.urls === []` and `pushUrls.length === 2`; push-only rewrite sync asserts zero `remote.origin.url` + dual-destination `push-only-proof`; push-only **create** sync (absent `deploy` remote) asserts zero `remote.deploy.url` + dual-destination `push-only-create-proof`; missing/non-git/**unreadable-config** sources assert throw + exact target remote snapshot equality; empty-valid source still clears target remotes. |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `coverage-ledger.mjs validate` exits 0 without output (no inventory adapter). Pre-existing. Tests self-tag `@level unit` and exercise real `git` integration fixtures (behavioral push proofs). |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | PASS | `tests/git_remotes.test.mjs` uses real `git` subprocesses and temp bare repos; no `page.route`, MSW, or first-party module mock. |
| No mock of a first-party internal seam module (real internals, faked externals) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules mock-internal-seam --diff origin/main` and whole-tree equivalent → 0 findings. |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | `tests/git_remotes.test.mjs` imports real `../git-remotes.ts` and shells out to real `git` via `execFileSync`; no money/auth surfaces. |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | Push-only dual-destination push proofs require both bare remotes to list `push-only-proof` (rewrite) and `push-only-create-proof` (create/absent remote). Read-failure cases (missing, non-git, unreadable config) require throw + byte-equal target remote snapshot (names/urls/pushUrls and `git remote` view). Empty-valid source clearing is distinguished from failure. |
| Every new branch / error path has a driving test | lead | PASS | Push-only multi-pushurl read; push-only multi-pushurl **rewrite** sync+push; push-only multi-pushurl **create/absent** sync+push (`ensureRemoteExists` path); valid empty remote set `[]`; missing path throw; non-git directory throw; unreadable-config throw; missing-source / non-git / unreadable-config sync non-mutation; empty-valid source still clears target — all in `tests/git_remotes.test.mjs` `#109` describes. #103 paths remain in the same file. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | Intended behavior change declared in issue #109 ACs + `docs/tests/2026-07-26-issue-109-git-remote-edge-cases-criteria.md`: (1) stop inventing fetch URL for push-only remotes; (2) throw on source read failure instead of returning `[]`. Existing #103 suite (multi-url, multi-pushurl with fetch URL, fetch-only, multi-remote, whitespace/metachar, stale clear) remains green as characterization of preserved contract. |
| Runtime smoke: each changed non-browser surface was actually run and its happy path responded | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-109.json` → push-only read; push-only rewrite + create sync dual-destination; missing/non-git/unreadable-config source abort leaves target unchanged for `git_remotes.read` and `git_remotes.sync`. |

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
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/ci-audit.mjs --files .github/workflows/ci.yml` → required inventory, ledger, checklist, evidence, smoke, and presentation gates absent from pre-existing CI configuration (same baseline gap as #103). Repo CI still runs `node --experimental-strip-types --test tests/*.test.mjs` via `.github/workflows/integration-tests.yml`. |
