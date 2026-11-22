---
status: accepted
date: 2026-11-22
---

# Clone and Worktree for isolated subagent work

Parallel writers need separate checkouts. Callers can select a workspace mode or explicitly request a disposable clone with `git_clone_workspace: true`. Both modes follow the common rules for preserving work and delivering results to the parent. [Subagent lifecycle](0007-subagent-lifecycle.md) · [Issue #622](https://github.com/1aboveio/pi-better-harness/issues/622)

## Workspace selection

For new write-capable subagents working in a Git repository, isolation defaults to **Clone**. In `/subagents settings`, **Git workspace** offers two choices.

| Mode | How it works |
| --- | --- |
| **Clone** (default) | Each worker gets a self-contained clone. Its Git metadata lives inside its own workspace, so Git can update its index and refs under the applicable project permissions. |
| **Worktree** | The harness creates a linked worktree at the selected base commit. Each worker gets its own checkout and index, and shares the repository's object store. Shared Git metadata remains subject to the active sandbox rules. |

The selection applies to new single and batch launches in the session. Ctrl+S saves the default for future sessions. An explicit clone request (`git_clone_workspace: true`) still selects Clone. Read-only work can use the source checkout directly. An explicit request to work in the live checkout remains a separate launch choice.

Record the actual mode, base commit, workspace and ownership in the launch recipe. Existing conversations continue in their recorded workspace, including older recipes without a mode. Changing the setting affects future launches. Changing an existing conversation's workspace requires the explicit handoff described below.

## Worktree permissions and feedback

At launch, tell the worker which mode it received. When the active profile restricts updates to the linked worktree's Git metadata, say so up front. The worker can edit and test within its permissions and return the changes for the parent to commit. The launcher does not need to predict which Git commands the worker will use.

If a Git operation encounters a **confirmed sandbox denial on the worktree's Git metadata**, tell the worker and its parent which operation was blocked, why, and where the current changes are. Let the caller choose how to proceed.

- Return the current changes to the parent for review and, if appropriate, commit.
- Continue the task in a Clone under the same sandbox policy. Stop writes to the source worktree, restore the saved state in the clone, and verify it before transferring the conversation's single writer. Continue from the blocked step without replaying earlier commands or their external effects.

A lock file alone is insufficient evidence of a permission denial. When an index lock blocks handoff, report the lock path and retain the original checkout until the lock is resolved. Report an ordinary merge conflict or failing hook as such. Workspace selection never grants additional permissions. On macOS, even a profile that permits writing outside the project can deny the rename or removal Git needs to finish an index update. [Verified permission behavior](https://github.com/1aboveio/pi-better-harness/pull/594)

## Restoring a Git checkout

For Clone and Worktree, the recoverable state includes the base and worker commits, staged and unstaged changes, new files and declared output artifacts. A restored checkout must preserve the distinction between staged and unstaged changes. If a conflicted rebase cannot be restored faithfully, retain the original checkout and report its location. When a linked worktree is reclaimed, also remove its Git registration. An eligible continuation can restore the reclaimed checkout from the saved state.

## Acceptance

1. With no saved preference, launch two writers and verify separate clones. Save Worktree in `/subagents settings`, reload, and repeat with two linked worktrees. In both modes, edits to the same file stay independent. Resuming an earlier conversation retains its original mode and changes.
2. In Worktree mode, edit a file and run a check under a profile that denies Git metadata updates. A blocked commit reports the operation and both recovery choices. Exercise each choice and verify the original edits arrive exactly once. A normal Git conflict reports its own cause.
3. In **each** mode, interrupt verification after a commit, a staged edit, an unstaged edit and a new file. Recover all four, including their staging state, and report verification as incomplete. Interrupt the save or handoff and verify that the source remains recoverable.
4. Complete multiple runs while another is waiting, then restart during cleanup. Finished checkouts and worktree registrations are reclaimed once results are recoverable. The waiting run resumes with its files, and a caller-owned checkout remains untouched.
