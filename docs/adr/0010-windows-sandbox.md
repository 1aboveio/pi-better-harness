# Windows sandbox: restricted tokens and harness-only ACL entries

## Status

Proposed (draft for review). Issue #344. Extends [ADR 0008](0008-write-without-delete.md), whose "Windows" paragraph this replaces once accepted.

## Problem

Windows has no sandbox backend. Confined subagents, and Main when enabled, fail closed with "sandbox is unsupported on win32". Windows needs the macOS behaviour for the Project files and Outside project levels (Off / Read / Write / Write & delete):

- temp, hidden home entries and worktree folders are always removable;
- the credential deny list is neither readable nor writable;
- code that runs later and harness state are not writable, removable or renamable;
- a backend that cannot be set up fails closed.

Seatbelt and Landlock check paths against rules held by the kernel for one process. Windows has no such layer for ordinary programs. The kernel's file access check reads only two things: the caller's token and the file's own access list (DACL). So any per-path rule on Windows has to be written into the DACLs of the real files. Inherited entries are copied into each file when it is created or when a parent's entry is propagated. A rule on a folder that already holds files means walking that folder once.

That leaves one real choice. Either the harness adds entries before each launch and removes them after it (a crash leaves them behind, and a large folder is walked twice per launch), or it adds entries once and leaves them there. This ADR picks the second and makes the leftover entries harmless.

## Decision

### Mechanism: a restricted token whose extra SIDs only the harness uses

A small launcher starts the task with a **restricted token** derived from the user's own token (`CreateRestrictedToken`). A restricted token is checked twice on every access: once with the user's normal groups, and once with a list of "restricting" SIDs (security identifiers) the harness picks. Access is granted only when **both** checks pass. So a restricted token can never do more than the user already can.

The restricting list holds:

- a few well-known SIDs that system folders already grant, so programs can start: Everyone, BUILTIN\Users, RESTRICTED (S-1-5-12, which the registry and many system objects grant for exactly this purpose), and the logon-session SID (window station and console access);
- **harness rule SIDs**: one SID per rule, such as "home is readable", "home is writable without delete", "this worktree folder is removable", "this credential path is denied". Each is a capability-style SID derived from a fixed name and a per-install salt (`DeriveCapabilitySidsFromName`, no admin needed).

The user's own SID, Administrators and Authenticated Users are never on the restricting list. A file the harness never granted to one of its SIDs is therefore out of reach, whatever the user could do with it. This is the same token shape Chromium uses for its GPU process and Codex uses for its Windows sandbox. It needs no administrator rights and no extra account.

A launch includes exactly the rule SIDs its policy grants or denies. Two concurrent launches with different levels on the same folder do not interfere, because they carry different SIDs.

### Why the leftover ACL entries are harmless

Each rule is written once as an entry in the DACL of its path, keyed to that rule's SID, and left there.

- An **allow** entry for a harness SID grants nothing to any real user or group. Only a restricted token lists that SID, and a restricted token is capped at what its user already has. A left-over allow entry can only ever narrow access, never widen it.
- A **deny** entry for a harness SID affects only restricted tokens that carry that SID, which means only sandboxed tasks.

A crash, a killed Pi, or an uninstalled package therefore leaves nothing that weakens the machine. Cleanup is tidiness, not a correctness step. When a rule stops being wanted (a path removed from `/sandbox deny`), the harness stops putting its SID in tokens. Its entry stays until the next repair or removal.

This answers the "no temporary changes that leak on crash" requirement by having no temporary changes. It does mean the user's folders carry extra DACL entries that `icacls` will show. That is the cost this ADR accepts (see Open questions).

### Write without delete on NTFS

NTFS allows a removal or rename when the caller has `DELETE` on the file or folder itself, or `FILE_DELETE_CHILD` on its parent. A rename also needs `DELETE` on an existing target it replaces. Writing in place (`FILE_WRITE_DATA`, `FILE_APPEND_DATA`, attributes) and creating (`FILE_ADD_FILE`, `FILE_ADD_SUBDIRECTORY` on the parent) are separate rights.

- "Write" grants read, execute and `FILE_GENERIC_WRITE` only. It grants neither `DELETE` nor `FILE_DELETE_CHILD`.
- "Removable" places get a separate rule SID that grants `DELETE`, inherited down the tree.
- No harness SID is ever granted `FILE_DELETE_CHILD`, `WRITE_DAC` or `WRITE_OWNER`. With no delete-child right anywhere, a removal always needs `DELETE` on the object itself, so a deny entry on a protected object cannot be bypassed from its parent. The task cannot rewrite any DACL: the user's implicit owner rights come from the user's SID, which is not on the restricting list.

The consequences match macOS: `rm`, `rm -rf`, `mv` away and rename-over-existing are refused outside removable places; in-place saves work; atomic saves and git commits under Write fail on the rename.

### What each level writes

All grants are inherited (`SUB_CONTAINERS_AND_OBJECTS_INHERIT`). "Once" means applied the first time it is needed and skipped when already present.

| Rule SID | Path | Entry |
| - | - | - |
| home-read | home | allow read + execute (once) |
| home-write | home | allow write, no delete (once, same pass as home-read) |
| removable(root) | each top-level dot entry of home, `%LOCALAPPDATA%\Temp`, each worktree folder found within three levels of home | allow `DELETE` (once per root) |
| project-read / -write / -delete (workspace) | workspace | allow read / write / `DELETE` (once per workspace) |
| project-off / project-readonly (workspace) | workspace | deny all / deny write + delete (once per workspace) |
| credential(path) | each credential entry | deny all (once per entry) |
| no-write(path) | each code-that-runs-later entry and caller `denyWrite` entry | deny write, delete, `WRITE_DAC`, `WRITE_OWNER` (once per entry) |
| anchor(path) | each ancestor of a protected entry and of the workspace | deny `DELETE`, not inherited (once per ancestor) |
| runtime scratch | the per-launch private temp | allow all, set on the empty directory at creation; it disappears with the directory |

Levels choose SIDs:

- Outside Off: no home rules. Project rules only.
- Outside Read: home-read.
- Outside Write: home-read, home-write, every removable(root), and the deny rules.
- Outside Write & delete: home-read, home-write, a home-wide removable rule, plus Authenticated Users on the restricting list so drives outside home that grant it (the Windows default for a new data drive) are writable as on macOS. Deny rules still apply.
- The Project row adds its own read/write/delete or off/readonly SID.

Explicit entries sort before inherited ones, and a deny sorts before an allow at the same level. Deny rules are always explicit on the protected entry, so they win over the inherited home grants. The plan compiler refuses one ordering it cannot express: a grant rooted *inside* a denied tree (for example a worktree folder under a read-only workspace). Such a grant is left out of that launch's token.

Absent deny-list entries are materialized before the first launch (an empty folder or file carrying the deny entry), as the Linux backend already does. Otherwise a task could create `~/.config/fish` itself.

### Windows additions to the fixed lists

- Credentials: `%APPDATA%\GitHub CLI`, `%APPDATA%\gcloud`, `%APPDATA%\rclone`, `%APPDATA%\Microsoft\Credentials`, `%LOCALAPPDATA%\Microsoft\Credentials`, `%APPDATA%\Microsoft\Protect` (DPAPI master keys), `%LOCALAPPDATA%\Microsoft\Vault`.
- Code that runs later: the Startup folder, PowerShell profile folders (`Documents\PowerShell`, `Documents\WindowsPowerShell`, resolved through the known-folder API because Documents is often redirected to OneDrive), `%LOCALAPPDATA%\Microsoft\WindowsApps`, `%APPDATA%\npm`, `~\scoop\shims`, and every directory on the user's `PATH` that lies under home.
- The registry needs no rule. HKCU grants the user, SYSTEM, Administrators and RESTRICTED (read only), so a sandboxed task can read HKCU but not write it. That also blocks `Run` keys and `cmd` `AutoRun`.

Symlinks and junctions need no hop list: an access through a link is checked against the target's own DACL. A link that is itself a protected entry gets its deny entry on the link object too (opened with `FILE_FLAG_OPEN_REPARSE_POINT`). Hard links share one DACL, and creating one needs write-attributes on the target.

### Launcher and helper

The launcher is a Node script run by the parent as the `SandboxCommand` (`node <launcher> <plan> -- <exec> <args>`), so callers keep spawning with ordinary stdio pipes. It calls Win32 through [koffi](https://koffi.dev) (MIT, prebuilt per platform):

1. build the restricted token (`DISABLE_MAX_PRIVILEGE | LUA_TOKEN`, Administrators and other admin groups set deny-only, default DACL = logon SID);
2. create a job object with kill-on-close and no breakaway, so killing the launcher kills the whole task tree;
3. `CreateProcessAsUserW` with a handle list holding only its three std handles;
4. wait and pass back the exit code.

`CreateProcessAsUserW` with a restricted copy of the caller's own token needs no special privilege. Any failure exits non-zero before the task starts: fail closed.

The ACL rules are applied in the parent (also via koffi) before the launcher runs. Applied rules are recorded in a state file inside harness state, which is itself on the no-write list.

### Setup, repair and removal

- **First use** walks home once (home-read and home-write in one propagation), then each dot entry and worktree folder once more for its removable rule. On a large home this can take minutes. It runs on the first confined launch with a visible progress line, and confined launches wait for it. A failure fails closed.
- **Each launch** checks that its rules are present (a DACL read per root, no walk), applies any new ones (a new worktree folder, a new deny entry), and materializes absent deny entries.
- `/sandbox windows repair` re-propagates, for files that were moved into home from elsewhere on the same drive (a move keeps the old DACL; such files are simply unreachable until repaired). `/sandbox windows remove` revokes every recorded harness SID from every recorded root.
- Files with inheritance turned off, and files locked during the walk, never receive the grants. They stay unreachable from the sandbox, which is the safe direction.

### Admin and standard users

Nothing here needs administrator rights. A standard user owns their home, so they can change its DACLs, and `CreateProcessAsUserW` on a restricted copy of their own token needs no privilege.

An elevated Pi (full admin token, as on GitHub's Windows runners) is handled by the token flags: every privilege except `SeChangeNotifyPrivilege` is removed, which matters because `SeBackupPrivilege` and `SeRestorePrivilege` bypass DACLs entirely; admin groups are deny-only; and admin SIDs are never on the restricting list. Files in home owned by Administrators or TrustedInstaller that the user cannot re-ACL are skipped and stay unreachable.

### What Windows does not match

- **Network Off is not enforceable** with a restricted token. Task launches with Network access Off are refused on Windows with a message to turn network on. The fixed internal file worker, which requests Network Off only as hardening, runs without it. The defaults (network on) are unaffected.
- **Removable places created during a run** (a new top-level dot entry, a new `*-worktrees` folder) become removable from the next launch, not immediately. Seatbelt matches names; NTFS inheritance cannot.
- **No recovery snapshot.** Volume Shadow Copy needs administrator rights.
- **Reads outside home** are limited to what Everyone, Users or RESTRICTED can read. A folder outside home readable only by the user's own SID is unreadable in the sandbox.
- **Credential services** (Credential Manager, `ssh-agent`'s named pipe) are reached through services that check the caller's token. Like Keychain on macOS, they are not governed by these rules, though DPAPI master keys are denied.

## Rejected options

- **AppContainer launcher** (pi-landstrip's first mode). An AppContainer process can read nothing in home until its SID is granted there, so it needs the same home-wide DACL walk. landstrip does that per run and revokes afterwards: a walk of home twice per launch, and entries left behind on a crash. Many developer tools also misbehave inside an AppContainer (HKCU virtualisation, loopback blocked without an administrator exemption, toolchains under `%LOCALAPPDATA%` needing explicit grants). Its one advantage, blocking network, does not outweigh that. It stays a candidate for enforcing Network Off later.
- **Restricted local account** (pi-landstrip's second mode, Codex's "elevated" mode). A separate hidden user gets grants on the real user's folders, and firewall (WFP) rules can block its network. It needs administrator rights to install, stores a password, fails on managed machines that forbid local accounts, and its grants on the real folders are real grants to a real account. Too heavy for a default.
- **Write-restricted token** (Codex's non-elevated mode). Its restricting SIDs apply to writes only, so reads need no grants at all, which is attractive. But the credential deny list must be unreadable, and a deny-read entry for a harness SID has no effect on a write-restricted token. Reading credentials would need a deny entry on the user's own SID, which would also lock the user out.
- **Deny entries on the user's own SID**, or **temporary entries added and removed per launch**. The first breaks the user outside the sandbox. The second leaks on crash and repeats the walk per launch.
- **Low integrity level.** A low-integrity process cannot write to anything labelled medium, which is all of home. Relabelling home as low would open it to every low-integrity process on the machine, such as browser sandboxes.
- **A filesystem minifilter driver.** It would give true path rules, but needs a signed kernel driver and an administrator install.
- **Native helper in Rust or C.** It would be faster per launch (a few milliseconds against about 100 ms for an extra Node process) and matches Codex and landstrip. But it adds a second language, a Windows build per architecture, per-platform npm packages to publish, and possibly code signing. koffi gives the same Win32 calls from TypeScript, is tested in this repo's runner, and installs only the one matching platform binary. If the spike (below) finds koffi cannot marshal the process-creation structures reliably, a Rust helper is the fallback.
- **PowerShell with `Add-Type` C#.** No binary to ship, but it costs 0.5 to 2 s per launch, and `Add-Type` is blocked under Constrained Language Mode, which managed machines often enforce.
- **Reusing landstrip directly.** Both its Windows modes grant `DELETE` with write, so neither provides Write without delete, and it is LGPL.

## Cost per install

- koffi's platform package for win32-x64 or win32-arm64: about 1 to 2 MB, installed on Windows only.
- One home walk at first use, and one walk per workspace the first time it needs a new rule.
- About 100 ms per confined launch for the launcher's Node startup, plus a few DACL reads.

## Implementation plan

0. **Spike on `windows-latest`** (throwaway branch, no product code): with koffi, start `cmd`, `node` and `git` under the restricted token, and prove on the real kernel: write in place works; unlink, rmdir, rename away and rename over an existing file are refused without `DELETE`; a deny-read entry blocks `type`; `icacls /grant` from inside fails on a file the task created and on one it can write; `SeBackupPrivilege` is gone; and, for the record behind the rejection above, a deny-read entry does not stop a write-restricted token. Run it both elevated (the runner's default) and as a standard local user created in the job. The result decides koffi against Rust.
1. **Plan compiler in `sandbox-core`** (pure, runs on every OS): backend id `windows-restricted-token`; win32 paths (case-insensitive containment, drive roots, `%LOCALAPPDATA%` temp); the Windows list additions; compile a policy into rule SIDs, DACL entries and the token's SID set, including the "grant inside a denied tree" refusal. Unit tests with a `platform: "win32"` seam on the existing lanes.
2. **ACL applier** (Windows only): idempotent ensure-entry with propagation, the rule state file, first-use progress, repair and remove.
3. **Launcher**: token, job object, handle list, `CreateProcessAsUserW`, exit code; plumbed through `SandboxCommand`.
4. **Wiring**: `selectedSandboxBackend` on win32, Network Off refusal with the internal-worker exception, `describeSandboxSupport` and `/sandbox` status, the packaging of koffi in the three packages that vendor `sandbox-core`.
5. **CI**: a `windows-sandbox` job with `PI_SANDBOX_REQUIRE_BACKEND=windows-restricted-token`, running a Windows port of the `broad-write.test.ts` kernel cases (Gradle-style cache written and cleaned; sibling repository `del /s`, `rmdir /s`, `move` refused with data intact; removal in temp, dot caches and worktree folders; deny list unreadable and unwritable including inside a dot folder; code-that-runs-later and harness state unwritable; a symlink and a junction to a protected entry; `git init`, `git clone`, `git worktree add`; Write & delete restoring removal; Network Off refused; setup failure failing closed), once elevated and once as a standard user. Keep `windows-verify` as it is.
6. **Docs**: README platform table and fail-closed list, ADR 0008's Windows paragraph, and this ADR to Accepted.

## Open questions

1. **Persistent DACL entries.** Is it acceptable that the user's home and workspaces keep harness-only entries (visible in `icacls`, harmless by construction) until `/sandbox windows remove`? The alternative, per-launch add and revoke, is slower and leaks on crash.
2. **First-use walk.** Should it run automatically on the first confined launch with progress, or only on an explicit `/sandbox windows setup`, with launches failing closed until then?
3. **`%LOCALAPPDATA%` as removable.** It is where Windows tools keep caches (npm, pip, yarn, NuGet). macOS does not treat `~/Library` as removable, so parity says no. Treating it as the Windows `~/.cache` would make cache cleanup work. Recommendation: keep parity (only its `Temp` is removable) and revisit on evidence.
4. **Network Off.** Is refusing it on Windows acceptable for now, with AppContainer or WFP as a later issue?
5. **Packaging.** koffi as a dependency of the three packages that vendor `sandbox-core`, or a new `sandbox-windows` workspace package they depend on?
6. **PATH-derived code-that-runs-later entries.** Protecting every `PATH` directory under home is broader than macOS's fixed `~/.local/bin` and `~/bin`. Keep it?
