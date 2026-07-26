# Test Criteria: Disposable Clone Workspaces for Sandboxed Git-Mutating Subagents

Source: [GitHub issue #78](https://github.com/1aboveio/pi-better-subagents/issues/78)

## Acceptance Criteria

1. **Explicit caller opt-in.** `subagent_spawn` exposes a `git_clone_workspace` parameter that requests a disposable Git clone workspace for a subagent that will mutate Git.
2. **Real `.git/` inside the sandbox root.** The prepared workspace is a full Git clone whose `.git/` directory lives inside the sandbox writable root, not a `.git` pointer to metadata outside the sandbox.
3. **Branch/commit preserved.** The clone checks out the same commit (and branch when applicable) that the source workspace was on before the subagent starts.
4. **Sandbox invariant preserved.** Writes remain confined to the clone workspace and normal Pi runtime paths; no broad write exceptions are added to the sandbox profile.
5. **Local reference acceleration.** The clone uses `git clone --reference-if-able <local-reference-repo> --dissociate <remote-url> <sandbox-workspace>` when a local reference is available, and falls back clearly when not.
6. **Self-contained clone.** After setup, the clone does not rely on a live alternates link to the parent repo.
7. **Linked worktree detection.** When Git mutation is requested, a sandboxed linked worktree (a `.git` file whose `gitdir` points outside the sandbox writable root) is detected.
8. **Fail-fast for unprepared linked worktrees.** A Git-mutating subagent is not launched in a sandboxed linked worktree unless the workspace has been converted/prepared into a writable clone. The failure message explains that linked worktree Git metadata is outside the sandbox and recommends disposable clone workspace mode.
9. **Git operations work in the clone.** Tests prove sandboxed Git operations work in the disposable clone workspace: status, fetch, edit, add, commit, rebase, conflict resolution plus rebase continue where practical, and push dry-run or mocked remote push. Commit-capable repo-local identity from the source (`user.name` / `user.email`, and `user.signingkey` when set) is preserved in the prepared clone so producers do not have to reconfigure identity inside the disposable workspace.
10. **Linked worktree detection coverage.** Tests prove linked worktree detection catches a `.git` pointer whose gitdir is outside the sandbox writable root.
11. **Non-Git sandbox behavior unchanged.** Tests prove existing non-Git-mutating sandbox behavior remains unchanged.
12. **Documentation.** Documentation explains that linked worktrees are unsuitable for sandboxed Git-mutating producer subagents and that clone workspace mode should be used instead.

## Test Strategy

| AC | Test level | Approach |
|---|---|---|
| 1, 4, 7, 8 | unit | Parameter schema and workspace-preparation logic in `git-workspace.ts`; fail-fast paths. |
| 2, 3, 5, 6 | unit + integration | Real `git` subprocesses create repos/worktrees/clones and assert resulting filesystem state and `git config`. |
| 9 | integration | Real Git commands run inside the prepared clone (status, fetch, commit, rebase, push dry-run). |
| 10 | unit | Construct a linked worktree with a `.git` pointer pointing outside the candidate sandbox root. |
| 11 | unit | Existing sandbox profile/wrapper tests continue to pass; new tests assert no behavior regression for non-clone mode. |
| 12 | docs | README update. |

## Mock/Integration Boundary

- Use real `git` subprocesses for all Git operations. Do not mock Git itself.
- First-party seams (`sandbox.ts`, `spawn.ts`) are real internals; tests may exercise them directly.
- External boundaries: `git` CLI on the host is a required test prerequisite. The suite fails clearly when `git` is absent (no conditional skip). The OS write-sandbox backend (`sandbox-exec` / `bwrap`) is required for the sandboxed Git integration path on the platform under test.
