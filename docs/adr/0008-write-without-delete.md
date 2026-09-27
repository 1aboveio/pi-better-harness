# Write without delete: broad writes, narrow removal

## Status

Accepted. Amends [ADR 0005](0005-sandbox-permission-table.md) (file levels, Subagents default) and extends [ADR 0007](0007-trusted-runtime-task-boundary.md)'s protected-path rules. Issue #341.

## Problem

Confined subagents could only write inside their workspace plus a few runtime exceptions. Tools with user-level caches failed or ran cold, and every new tool needed another allowlist entry. Example: an Android build failed on `~/.gradle/wrapper/dists/…/gradle-8.14.3-bin.zip.lck (Operation not permitted)`. The workaround, a private `GRADLE_USER_HOME`, forced a cold download that timed out after 20 minutes. Allowlisting each tool does not scale.

The main risk of a looser sandbox is destructive removal of user data (`rm -rf`, `mv` away), not writing in general.

## Decision

The Project files and Outside project rows each have four levels:

| Level | Meaning |
| ----- | ------- |
| Off | No access. |
| Read | Read only. |
| Write | Read, create, and overwrite in place. Nothing can be removed or renamed away. |
| Write & delete | The level previously called "Read / write". Saved `read-write` values keep this meaning. |

Removal is always allowed, whatever the rows say, in the places that are disposable by nature: temp, hidden (dot) entries of the home directory, and git worktree folders (`.worktrees/`, `*-worktrees/`). The deny list below still wins there.

**Outside project = Write is the broad-write profile.** Writes are allowed across the home directory and temp, not the whole filesystem. One fixed deny list applies and is not configurable per tool:

- credentials: the Stored credentials files (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.config/gcloud`, `~/.azure`, `~/.kube`, `~/.docker/config.json`, `~/.npmrc`, `~/.netrc`, `~/.git-credentials`, `~/.pi/agent/auth.json` or `$PI_CODING_AGENT_DIR/auth.json`), plus `~/Library/Keychains`, `~/.claude/.credentials.json`, `~/.claude.json`, `~/.gnupg`, `~/.codex/auth.json`, `~/.cargo/credentials.toml`, `~/.cargo/credentials`, `~/.pgpass`, and `~/.config/rclone`. They are neither readable nor writable, whatever the Stored credentials row says. The table shows that row as "Off (fixed)".
- code that runs later: shell startup files (`.bashrc`, `.bash_profile`, `.bash_login`, `.bash_logout`, `.profile`, `.zshrc`, `.zshenv`, `.zprofile`, `.zlogin`, `.zlogout`), `~/.config/fish`, `~/.gitconfig`, `~/.config/git`, `~/.config/systemd/user`, `~/.config/autostart`, `~/.pi` (or `$PI_CODING_AGENT_DIR`), `~/.claude`, `~/.agents`, `~/Library/LaunchAgents`, `~/.local/bin`, `~/bin`, `~/.git-templates`, `~/.oh-my-zsh/custom`, `~/.gradle/init.d`, `~/.cargo/config.toml`, and `~/.cargo/config`. They cannot be written, removed, or renamed. They stay readable, because a confined subagent reads its skills and extension sources from these directories. Their parent directories cannot be removed or renamed either, so for example `~/.gradle` and `~/.cargo` can be cleaned inside but not removed as a whole.
- harness state the parent trusts: each launcher's `denyWrite` entries (registry roots, run and control directories, task-runtime provenance, runtime code, the scratch anchor). These cannot be written, removed, or renamed. The #325 provenance trust check therefore still holds.

Every fixed-list entry and every `denyWrite` entry is protected under all of its names. That covers the literal path under home, every user-replaceable symlink met while resolving it (followed component by component, stopping at a loop or after 40 hops), and the path it finally resolves to.

Dotfiles managers such as stow and chezmoi make `~/.zshrc`, `~/.ssh` or `~/.config` symlinks, sometimes through a chain such as `~/.zshrc -> ~/.dotfiles/zshrc -> ~/dotfiles/zshrc`. Guarding only the ends would let a task replace a link and retarget the entry. Ancestors of every name are anchored. A link created after launch is not a hop at launch time, but it only redirects paths: the resolved targets stay protected.

**Git configuration and hooks under home are not protected** (a deliberate efficiency trade-off). Protecting them broke `git init`, `git clone` and `git worktree add`, because git copies `.git/hooks/*.sample` from its template directory, and it was bypassable anyway. A task can therefore plant code that runs on a later git command through:
- `.git/hooks` of any repository, including the workspace's;
- a repository's `.git/config` (`core.hooksPath`, `core.fsmonitor`, `diff.external`, filters, aliases);
- submodule hooks under `.git/modules/*/hooks`;
- `gitdir:` redirects in a worktree's `.git` file;
- files named by `[include]` in `~/.gitconfig`.

`~/.gitconfig`, `~/.config/git` and `~/.git-templates` themselves remain on the fixed list. Outside project = Write therefore also drops the workspace's `.git/hooks` from the subagent `denyWrite` list. Read and Off keep it.

Extra paths for the deny list come from the existing `/sandbox deny` rules.

The Subagents default is Project files = Write & delete and Outside project = Write. Main keeps Outside project = Read. Background tasks follow Main's profile. In `/sandbox`, a looser value (a higher level, a capability switched on, a sandbox switched off) applies in-session only on a second Space. Saving looser defaults needs a second Enter. Both prompts name each loosened cell. No model tool can change any of this.

## Platform enforcement

**macOS (Seatbelt).** Seatbelt has no separate rename operation. `file-write-unlink` guards unlink, rmdir, the source of a rename, an existing destination a rename replaces, and both sides of `renamex_np(RENAME_SWAP)`. The profile denies `file-write-unlink` everywhere except the disposable places (and a Write & delete workspace). Real-kernel tests found two consequences:

1. A save that writes a temp file and renames it over an existing file needs removal on the destination. It fails under Write, as do git commits (lock-file renames). Writing a file in place (truncate + write, as Pi's `write`/`edit` tools do) works. This is inherent to the kernel: Landlock has the same constraint (`REMOVE_FILE` on both directories of such a rename).
2. A rule naming `file-write-unlink` outranks a `file-write*` wildcard whatever their order. Every deny-list path therefore also gets an explicit `file-write-unlink` denial. Otherwise a removal allowance, such as "dot entries of home", would reopen a credential inside `~/.config`.

Ancestors of protected paths and of the workspace are anchored with literal unlink denials, so renaming a parent cannot carry a protected subtree to an unprotected path or redirect the next launch.

The Seatbelt profile keeps `(allow default)`, so Mach IPC to system daemons stays open. `security` and `tmutil` work inside the sandbox, which means a hostile task could reach `securityd` for Keychain items it is allowed to query, and could likely delete the recovery snapshots below (`tmutil deletelocalsnapshots`). This is a known limit of this profile, not addressed here.

**Linux (Bubblewrap fallback).** Landlock (5.19+) can separate remove rights from write rights, but nothing in this codebase can apply it: Node has no Landlock binding and bwrap does not expose it. A native helper would be new security engineering. Linux therefore uses the fallback:

- `/` is read-only.
- Temp (`/tmp`, `/var/tmp`, `/dev/shm`), the workspace, hidden top-level home entries, and worktree folders found within three levels of home are writable, removal included.
- Ordinary top-level home folders stay read-only, and so does home itself: new top-level home entries cannot be created.
- Credentials are masked by empty mode-000 mounts. Code that runs later and caller-denied paths are read-only binds.
- Every writable bind and protected leaf is a mount point, which Linux refuses to rename.

The gap: on Linux, Outside project = Write cannot edit a sibling repository under `~/projects` at all (read-only), and removal inside dot directories and temp is unrestricted, just as on macOS. Every symlink hop of a deny-list entry that sits in a writable directory makes that directory read-only; top-level links are covered by the read-only home. Project files = Write cannot be enforced on Linux and is refused at launch with a message to choose Write & delete or Read.

**Windows.** There is no backend. Confined subagents, and Main when enabled, fail closed with "sandbox is unsupported on win32". NTFS ACLs do separate `DELETE`/`FILE_DELETE_CHILD` from write. Using that would need a restricted token or AppContainer launched through a native helper, or persistent Deny ACEs on the user's real folders. Both are out of scope for this change and are left for a follow-up.

## Recovery backstop

On macOS, a confined subagent or background-task launch whose Outside project level is Write or Write & delete starts `tmutil localsnapshot` in the background. It needs no elevated privileges. Write & delete can remove files outside the project, and Write can still truncate, chmod or chflags them in place. There is at most one snapshot per 15 minutes per Pi process. The run starts immediately and never waits. A failure is reported as a warning (subagents) or a task-log line (background tasks). `PI_SANDBOX_RECOVERY_SNAPSHOT=off` turns it off, and the test suites set it. Local snapshots are purgeable and volume-wide, and the task itself can probably delete them (see the Mach IPC limit above). They are a recovery aid, not a guarantee.

## Verification

- `packages/sandbox-core/broad-write.test.ts`: policy compilation units (profile selection, forced-off credentials, write/read/remove decisions, Seatbelt rule order, Linux mount plan) and real-kernel tests on both sandbox lanes. The kernel tests cover a Gradle-style user cache written and cleaned; `rm`, `rm -rf`, `mv` away, and `RENAME_SWAP` of a sibling repository refused with its data intact; removal in the workspace, temp, dot caches, and worktree folders; deny-list reads and writes refused, including removal and renaming of a credential inside a dot directory; symlinked dotfiles (stow/chezmoi layout) and 2- and 3-hop file and directory chains for credentials, code that runs later, and harness state; the extended list (GnuPG, Codex auth, `~/.local/bin`); `git init`, `git clone` and `git worktree add` in the workspace and a worktree folder; registry and provenance writes refused; Write & delete restoring removal.
- `packages/pi-better-subagents/tests/task_runtime.test.mjs`: the Subagents default through the real SDK tool dispatcher.
- Golden path `outside-write` in `docs/tests/sandbox-compatibility.smoke.manifest.json`.
