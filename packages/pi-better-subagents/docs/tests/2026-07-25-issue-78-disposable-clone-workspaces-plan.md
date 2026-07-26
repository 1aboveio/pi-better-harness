# Incremental Plan: Issue #78 — Disposable Clone Workspaces

## Slices

1. **Add `git-workspace.ts` helper module** (RED → GREEN)
   - `isLinkedWorktree(dir)`: detect `.git` file with `gitdir:` pointer.
   - `resolveGitCommonDir(dir)`: find the main repository object database for reference acceleration.
   - `prepareGitCloneWorkspace(options)`: clone with `--reference-if-able`/`--dissociate`, checkout source commit, return clone directory.
   - Fail-fast with a clear message when the source is a linked worktree and cannot be converted to a writable clone.
   - Tests first, then implementation.

2. **Wire `git_clone_workspace` into `subagent_spawn`** (RED → GREEN)
   - Add `git_clone_workspace` boolean parameter to tool schema and prompt guidelines.
   - When true and sandboxed, call `prepareGitCloneWorkspace` before building the sandbox command.
   - Update `cwd` and `requestedSandboxDir` to the clone directory.
   - Preserve non-clone behavior exactly.
   - Tests first, then implementation.

3. **Integration tests for Git operations in clone workspace**
   - Prepare a clone and exercise status, fetch, edit, add, commit, rebase, conflict-resolution/continue, push dry-run.
   - Assert `.git` is a directory inside the sandbox root.
   - Assert alternates are gone after `--dissociate`.
   - Assert repo-local Git identity is preserved so commits work without reconfiguring the clone.

4. **Documentation**
   - Update README.md to explain linked-worktree hazard and `git_clone_workspace` usage.

5. **Close-out gates**
   - Run unit tests.
   - Run `scope-class.mjs classify`.
   - Run `coverage-checklist.mjs generate` + `validate`.
   - Run `scan-diff.mjs`.
   - Open PR with Review Contract.
