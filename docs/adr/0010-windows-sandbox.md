# Windows sandbox: restricted tokens and harness-only ACL entries

## Status

Proposed. Design and spike only; no product code yet. One problem is open: child processes with piped stdio (see [Open problem](#open-problem-child-processes-with-pipes)). Issue #344. Extends [ADR 0008](0008-write-without-delete.md), whose "Windows" paragraph this replaces once accepted.

## Problem

Windows has no sandbox backend. Confined subagents, and Main when enabled, fail closed with "sandbox is unsupported on win32". Windows needs the macOS behaviour for the Project files and Outside project levels (Off / Read / Write / Write & delete):

- temp, hidden home entries and worktree folders are always removable;
- the credential deny list is neither readable nor writable;
- code that runs later and harness state are not writable, removable or renamable;
- a backend that cannot be set up fails closed.

Seatbelt and Landlock check paths against rules the kernel holds for one process. Windows has no such layer for ordinary programs. Its file access check reads only the caller's token and the file's own access list (DACL). Any per-path rule on Windows therefore lives in the DACLs of the real files. Inherited entries are copied into each file when it is created or when a parent's entry is propagated, so a rule on a folder that already holds files means walking that folder once.

That leaves one real choice. Either the harness adds entries before each launch and removes them afterwards (a crash leaves them behind, and a large folder is walked twice per launch), or it adds entries once and leaves them. This ADR picks the second and makes the leftover entries harmless.

## Decision

### Mechanism: a restricted token with harness-only SIDs

A launcher starts the task with a **restricted token** derived from the user's own token (`CreateRestrictedToken`). Windows checks a restricted token twice on every access: once with the user's normal groups, and once with a list of "restricting" SIDs (security identifiers) the harness picks. Access is granted only when **both** checks pass, so a restricted token never does more than its user can.

The restricting list holds:

- well-known SIDs that system folders already grant, so programs can start: Everyone, BUILTIN\Users, RESTRICTED (S-1-5-12) and the logon-session SID;
- **harness rule SIDs**, one per rule ("home is readable", "home is writable without delete", "this folder is removable", "this credential is denied"). Each is a random `S-1-5-21-a-b-c-d` SID, the form Codex uses, persisted in harness state. The spike showed that `CreateRestrictedToken` refuses capability-form SIDs (`S-1-15-3-…`) as restricting SIDs, with error 87.

The user's own SID, Administrators and Authenticated Users are never on the restricting list. A file the harness never granted to one of its SIDs is out of reach. No administrator rights and no extra account are needed.

A launch carries exactly the rule SIDs its policy grants or denies. Two concurrent launches with different levels on the same folder do not interfere, because they carry different SIDs.

### Why the leftover entries are harmless

Each rule is written once, as a DACL entry keyed to that rule's SID, and left in place until `/sandbox windows remove`.

- An **allow** entry for a harness SID grants nothing to any real user or group. Only a restricted token lists that SID, and a restricted token is capped at what its user already has.
- A **deny** entry for a harness SID affects only restricted tokens that carry it, which means only sandboxed tasks.

So a crash, a killed Pi or an uninstalled package leaves nothing that weakens the machine. Cleanup is housekeeping, not a correctness step. When a rule stops being wanted (a path removed from `/sandbox deny`), the harness stops putting its SID in tokens. Its entry stays until repair or removal. `icacls` shows the entries as unresolved SIDs.

### Write without delete on NTFS

NTFS allows a removal or rename with `DELETE` on the object, or with `FILE_DELETE_CHILD` on its parent. A rename also needs `DELETE` on an existing target it replaces. Writing in place and creating are separate rights.

- Write grants read, execute and `FILE_GENERIC_WRITE`, with neither `DELETE` nor `FILE_DELETE_CHILD`.
- Removable places get a separate rule SID that grants `DELETE`, inherited down the tree.
- No harness SID is ever granted `FILE_DELETE_CHILD`, `WRITE_DAC` or `WRITE_OWNER`. Removal therefore always needs `DELETE` on the object itself, so a deny entry on a protected object cannot be bypassed from its parent. The task cannot rewrite any DACL, including on files it created.

The consequences match macOS: `rm`, `rm -rf`, `mv` away and rename-over-existing are refused outside removable places; in-place saves work; atomic saves and git commits under Write fail on the rename. A file the task creates in an ordinary folder is not removable either.

### What each level writes

Grants are inherited (`SUB_CONTAINERS_AND_OBJECTS_INHERIT`). "Once" means applied the first time it is needed and skipped when present.

| Rule SID | Path | Entry |
| - | - | - |
| home-read | home | allow read + execute (once) |
| home-write | home | allow write, no delete (once, same walk as home-read) |
| removable(root) | each top-level dot entry of home, `%LOCALAPPDATA%\Temp`, each worktree folder found within three levels of home | allow `DELETE` (once per root) |
| project-read / -write / -delete | workspace | allow read / write / `DELETE` (once per workspace) |
| project-off / project-readonly | workspace | deny all / deny write + delete (once per workspace) |
| credential(path) | each credential entry | deny all (once per entry) |
| no-write(path) | each code-that-runs-later entry and caller `denyWrite` entry | deny write, delete, `WRITE_DAC`, `WRITE_OWNER` (once per entry) |
| anchor(path) | each ancestor of a protected entry and of the workspace | deny `DELETE`, not inherited (once per ancestor) |
| runtime scratch | the per-launch private temp | allow all, set on the empty directory at creation; it goes with the directory |

Levels choose SIDs:

- Outside Off: no home rules; project rules only.
- Outside Read: home-read.
- Outside Write: home-read, home-write, every removable(root), and the deny rules.
- Outside Write & delete: home-read, home-write, a home-wide removable rule, and Authenticated Users on the restricting list, so drives outside home that grant it (the default for a new data drive) are writable as on macOS. Deny rules still apply.
- The Project row adds its own SID.

Explicit entries sort before inherited ones, and a deny sorts before an allow at the same level. Deny rules are always explicit on the protected entry, so they beat the inherited home grants. The plan compiler leaves out a grant rooted *inside* a denied tree (for example a worktree folder under a read-only workspace), because an explicit allow there would outrank the inherited deny.

Absent deny-list entries are materialized before the first launch (an empty folder or file carrying the deny entry), as the Linux backend already does. Otherwise a task could create `~/.config/fish` itself.

`%LOCALAPPDATA%` is not removable, for parity with macOS's `~/Library`. Only its `Temp` folder is. Tool caches there (npm, pip, NuGet) are writable but not cleanable under Write.

### Windows additions to the fixed lists

- Credentials: `%APPDATA%\GitHub CLI`, `%APPDATA%\gcloud`, `%APPDATA%\rclone`, `%APPDATA%\Microsoft\Credentials`, `%LOCALAPPDATA%\Microsoft\Credentials`, `%APPDATA%\Microsoft\Protect` (DPAPI master keys), `%LOCALAPPDATA%\Microsoft\Vault`.
- Code that runs later, a fixed list that mirrors macOS's intent: `~\bin`, `~\.local\bin`, the PowerShell profile folders (`Documents\PowerShell`, `Documents\WindowsPowerShell`, resolved through the known-folder API because Documents is often redirected to OneDrive), the Startup folder, the git config and template entries already on the list, `~\.pi`, `~\.claude`, `~\.agents`, and harness state. Tool bin folders such as `%APPDATA%\npm` stay writable, so `npm -g` works. `PATH` entries are not derived automatically.
- The registry: HKCU `…\CurrentVersion\Run` and `RunOnce` are code that runs later. Whether a restricted token already blocks all HKCU writes is not yet known (see the open problem). The rule to follow either way: HKCU stays writable where tools need it, and `Run`, `RunOnce` and similar autostart keys get a deny entry. If a restricted token blocks every HKCU write, the harness grants a rule SID write on `HKCU\Software` (registry DACLs carry harness SIDs just like files; the spike set one) and denies the autostart keys.

Symlinks and junctions need no hop list: an access through a link is checked against the target's own DACL. The spike confirmed that a junction to `.ssh` does not expose it. A link that is itself a protected entry also gets its deny entry on the link object (opened with `FILE_FLAG_OPEN_REPARSE_POINT`).

### Launcher and helper: koffi

The launcher is a Node script the parent runs as the `SandboxCommand` (`node <launcher> <plan> -- <exec> <args>`), so callers keep spawning with ordinary stdio pipes. It calls Win32 through [koffi](https://koffi.dev) (MIT):

1. mark its three std handles inheritable again (Node clears inheritance at startup);
2. build the restricted token (`DISABLE_MAX_PRIVILEGE | LUA_TOKEN`, Administrators deny-only, a default DACL for the user, the logon SID and SYSTEM, and medium integrity when Pi runs elevated);
3. create a job object with kill-on-close, so killing the launcher kills the whole task tree;
4. `CreateProcessAsUserW` with only the std handles inherited, then wait and pass back the exit code.

Any failure exits non-zero before the task starts, so the launch fails closed. The parent applies the ACL rules beforehand, also through koffi (`SetEntriesInAclW` plus `SetNamedSecurityInfoW`). `icacls` cannot be used because it cannot name SIDs that do not map to an account. Applied rules are recorded in a state file inside harness state, which is on the no-write list.

**Packaging.** koffi is an `optionalDependencies` entry, installed on win32 only, of each package that vendors `sandbox-core`: `pi-better-sandbox`, `pi-better-subagents` and `pi-better-background-tasks`. It is loaded lazily only on win32, and macOS and Linux never need it. The `pi-better-harness` bundle (`stage-harness-dependencies`, `bundledDependencies`) must still pack correctly, which the implementation will check. There is no new package.

**Costs, measured in the spike.** koffi's win32 platform package is about 1 to 2 MB, installed on Windows only. The launcher adds about 60 ms per launch (72 ms against 11 ms direct). Propagating an inherited entry over 20,000 files took 2.3 to 3.3 s, about 3 minutes per million files.

### Setup, repair and removal

- **First use** walks home once (home-read and home-write in one propagation), then each dot entry and worktree folder once more. It runs automatically on the first confined launch, with a progress line, and that launch waits for it. A failure fails closed.
- **Each launch** checks that its rules are present (one DACL read per root, no walk), applies new ones (a new worktree folder, a new deny entry), and materializes absent deny entries.
- `/sandbox windows repair` re-propagates, for files that were moved into home from elsewhere on the same drive (a move keeps the old DACL; such files stay unreachable until repaired). `/sandbox windows remove` revokes every recorded harness SID from every recorded root.
- Files with inheritance turned off, and files locked during the walk, never receive the grants. They stay unreachable from the sandbox, which is the safe direction.

### Admin and standard users

Nothing here needs administrator rights, and the spike showed identical results for both. A standard user owns their home, so they can change its DACLs. `CreateProcessAsUserW` with a restricted copy of their own token needs no privilege.

An elevated Pi, as on GitHub's Windows runners, keeps only `SeChangeNotifyPrivilege`. That matters because `SeBackupPrivilege` and `SeRestorePrivilege` bypass DACLs. Admin groups are deny-only and never on the restricting list. Files in home owned by Administrators or TrustedInstaller that the user cannot re-ACL are skipped and stay unreachable.

### What Windows does not match

- **Network Off is refused.** A restricted token cannot block network access. Task launches with Network access Off fail with a message saying it is unsupported on Windows. The fixed internal file worker, which asks for Network Off only as hardening, runs without it. The defaults (network on) are unaffected. Enforcing it (WFP or AppContainer) is a follow-up issue.
- **Removable places created during a run** (a new top-level dot entry, a new `*-worktrees` folder) become removable from the next launch, not immediately.
- **No recovery snapshot.** Volume Shadow Copy needs administrator rights.
- **Reads outside home** are limited to what Everyone, Users or RESTRICTED can read.
- **Credential services** (Credential Manager, the `ssh-agent` pipe) check the caller's token in a separate service. Like Keychain on macOS, they are not governed by these rules, though the DPAPI master keys are denied.

## Spike results

A throwaway spike ran on `windows-latest` on branch [`spike/windows-sandbox-344`](https://github.com/1aboveio/pi-better-harness/tree/spike/windows-sandbox-344) (latest run: [36331510326](https://github.com/1aboveio/pi-better-harness/actions/runs/36331510326)). It ran as the elevated runner account (high integrity) and as a new standard local user (medium integrity). The results were identical.

**Proven with the restricted token.** Rule SIDs were set through koffi, and the task was a Node probe:

- Sibling repository under home (home-read + home-write): read, in-place write, append, new file and new folder work. Unlink, unlinking a file the task just created, rmdir, rename away, rename over an existing file, moving the folder into a dot folder, `fs.rmSync` recursive and `rmdir /s` are all refused. All files are still present afterwards.
- A hard link to `.bashrc` is refused. `icacls /grant` from inside is refused, both on a writable file and on a file the task created.
- Dot-folder caches, temp and the Write & delete workspace: unlink, `rm -rf` of a subtree, create-and-delete, rename over existing and rename all work.
- Credentials (`.ssh`, and `.config\gh` inside a removable dot folder): read, list, write, unlink and rename of the folder are refused. Reading through a junction planted in a writable folder is refused. Renaming the protected entry's parent (`.config`, anchored) is refused. Unrelated files in `.config` stay removable.
- `.bashrc` (code that runs later): readable; write, unlink and rename-over are refused.
- A folder under the user's profile with no rule grants is unreadable.
- `DeriveCapabilitySidsFromName` works without admin but is not needed, because capability SIDs are refused as restricting SIDs.

**Write-restricted token, rejected on evidence.** A write-restricted token with the same SIDs and entries (Codex's non-elevated mode) allowed unlink, rename, `rm -rf` and moving away of the sibling repository. It allowed reading and listing `.ssh` and reading `.config\gh`. It allowed renaming `.ssh`, `.config\gh` and the anchored `.config`, and replacing `.bashrc` by rename, and it read the no-grant folder. Its extra SIDs are not applied to reads or deletes the way this design needs.

**Mechanics learned:**

- `CreateRestrictedToken` accepts `S-1-5-21-…` rule SIDs and refuses `S-1-15-3-…` capability SIDs with error 87.
- `icacls` cannot name these SIDs ("No mapping between account names and security IDs"). koffi calling `SetEntriesInAclW` and `SetNamedSecurityInfoW` works, for files and for registry keys.
- Node marks its std handles non-inheritable at startup. The launcher must set `HANDLE_FLAG_INHERIT` again, or the task's output is lost.
- A default DACL on the restricted token is needed. Without it, even `CreatePipe` fails inside the task.
- Structures must be packed by hand in some places (the `SID_AND_ATTRIBUTES` array), and a crash in the native call takes down the process. The production launcher keeps each Win32 step behind a checked wrapper and never runs koffi in the parent's own process for process creation.

## Open problem: child processes with pipes

Inside the sandbox, a child started with ignored stdio runs (`cmd.exe`, `node.exe`), but a child started with piped stdio fails with `EPERM`. Anonymous pipes (`CreatePipe`) work. Creating a named pipe works, but opening its client end fails with access denied. libuv, Node's I/O layer, uses named pipes for child stdio, so every `execFileSync` or `spawn` with pipes fails. Until this is solved, most real tool use inside the sandbox fails.

The following spike results are this blocker, not the file rules, and prove nothing yet:

- `git init`, `git commit` and `git worktree add` in the workspace;
- every registry probe (`reg query` and `reg add` on HKCU `Software`, `Run`, `RunOnce`, `Environment` and `Classes`, and on a key granted to a rule SID), because `reg.exe` was started with pipes. Whether a restricted token blocks all HKCU writes is therefore still unknown;
- the tool smoke tests (`cmd /c echo`, `npm`, `git`, `pwsh`, `powershell`, `python`, `dotnet`) and the network probe;
- `whoami /priv` and `whoami /groups` inside the task.

The launcher's own pipe to the parent works, because the task inherits the handles directly. Implementation stops until this problem has an agreed direction.

## Rejected options

- **Write-restricted token** (Codex's non-elevated mode). Rejected on the spike evidence above: deletes, renames and credential reads all went through.
- **AppContainer launcher** (pi-landstrip's first mode). It needs the same home-wide DACL walk to read home at all. landstrip does that per run and revokes afterwards: two walks of home per launch, and entries left behind on a crash. Many developer tools misbehave inside it (HKCU virtualisation, loopback blocked without an admin exemption, toolchains under `%LOCALAPPDATA%` needing explicit grants). It remains a candidate for enforcing Network Off later.
- **Restricted local account** (pi-landstrip's second mode, Codex's elevated mode). It needs admin to install, stores a password, fails where local accounts are forbidden, and its grants go to a real account.
- **Deny entries on the user's own SID**, or **temporary entries per launch**. The first locks the user out outside the sandbox. The second leaks on crash and repeats the walk every launch.
- **Low integrity level.** It cannot write anything labelled medium, which is all of home. Relabelling home would open it to every low-integrity process, such as browser sandboxes.
- **Filesystem minifilter driver.** It needs a signed kernel driver and an admin install.
- **Native helper in Rust or C.** It would save about 60 ms per launch, but adds a second language, a Windows build per architecture, per-platform packages and possibly code signing. koffi did every call the spike needed, so it is chosen. Rust remains the fallback if koffi proves unreliable.
- **PowerShell with `Add-Type` C#.** It costs 0.5 to 2 s per launch and is blocked under Constrained Language Mode. The spike also hit Windows PowerShell failing to load its own modules when started from `pwsh`.
- **Reusing landstrip directly.** Both its Windows modes grant `DELETE` together with write, and it is LGPL.

## Implementation plan (after the open problem is resolved)

1. **Plan compiler in `sandbox-core`**, pure code that runs on every OS: backend id `windows-restricted-token`; win32 paths (case-insensitive containment, drive roots, `%LOCALAPPDATA%\Temp`); the Windows list additions; compiling a policy into rule SIDs, DACL entries and the token's SID set, including leaving out grants inside denied trees. Unit tests use a `platform: "win32"` seam on the existing lanes.
2. **ACL applier** (Windows only): idempotent ensure-entry with propagation, the rule state file, the automatic first walk with progress, repair and remove. Registry rules per the answer to the open problem.
3. **Launcher**: handle inheritance, token, default DACL, job object, `CreateProcessAsUserW`, exit code; plumbed through `SandboxCommand`.
4. **Wiring**: `selectedSandboxBackend` on win32; the Network Off refusal with the internal-worker exception; `describeSandboxSupport` and `/sandbox` status; koffi as a win32-only optional dependency of the three packages, with the harness bundle checked.
5. **CI**: a `windows-sandbox` job with `PI_SANDBOX_REQUIRE_BACKEND=windows-restricted-token`, running the spike's cases as `node:test` suites plus the `broad-write.test.ts` kernel cases, once elevated and once as a standard local user. `windows-verify` stays as it is.
6. **Docs**: README platform table and fail-closed list, ADR 0008's Windows paragraph, and this ADR to Accepted.
