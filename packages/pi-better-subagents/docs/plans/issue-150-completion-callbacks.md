# Plan — issue #150: outcome-focused completion callbacks

Branch: fix/issue-150-completion-callbacks → main. Prior art: bb3e31f (unrelated branch; cherry-pick impossible under sandbox — git index unwritable — so recreating the focused diff).

## AC → slice map
- AC1 (long/repetitive trace → no tools list in callback): tests `callback_completion.test.mjs` — `formatCallbackTrigger` 100-tool trace case; `buildCompletionDelivery` repeated-trace case. Code: `completion.mjs` drop `tools` from `formatCallbackTrigger` + `buildCompletionDelivery`.
- AC2 (metadata + completed/failed/incomplete wording intact): existing tests in `callback_completion.test.mjs` (verdict/wording suites) must stay green; doc comments updated.
- AC3 (regression on finalization→delivery path): `run_finalization.test.mjs` complete-exit test gains `doesNotMatch(/read|tools:/i)` on delivered content. Code: `finalization.ts` stops building/passing `tools`.
- AC4 (suite + typecheck pass): `npm test -w pi-better-subagents`, `npm run typecheck`.

## TDD
1. RED: apply test edits → run two test files → expect failures naming the trace leak.
2. GREEN: apply code edits → re-run → pass.
3. Full package suite + typecheck.

## Close-out gates
- scope-class.mjs classify (net diff vs merge-base origin/main)
- coverage-checklist.mjs generate + validate --diff <merge-base>
- lint-tests.mjs --rules no-skip,no-fixed-timeout,no-empty-test,mock-internal-seam --diff <merge-base>; then bare mock-internal-seam
- coverage-ledger.mjs validate
- scan-diff.mjs over net diff (findings channel verbatim)

## Commit/push under sandbox
Shared gitdir is write-denied (sandbox-exec). Use GIT_INDEX_FILE + GIT_OBJECT_DIRECTORY inside the worktree with GIT_ALTERNATE_OBJECT_DIRECTORIES at the real object store; commit-tree; `git push origin <sha>:refs/heads/fix/issue-150-completion-callbacks`; verify with ls-remote.

## Status
- [x] context collected
- [x] RED — 3 failures on the trace leak (formatCallbackTrigger trace case, buildCompletionDelivery trace case, run_finalization complete-exit assertion)
- [x] GREEN — focused files pass; package suite 601 pass / 1 fail (git-workspace outside-write-denial test: environmental, sandbox denies its $HOME mkdir; reproduces on untouched main checkout)
- [ ] gates
- [ ] PR open
