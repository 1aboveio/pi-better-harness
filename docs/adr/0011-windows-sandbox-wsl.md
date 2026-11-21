# Windows sandbox: run confined work in WSL 2 with the Bubblewrap backend

## Status

Proposed. Supersedes [ADR 0010](0010-windows-sandbox.md) (native restricted token), which is shelved on its child-process pipe blocker. Issue #344. When accepted, this replaces the "Windows" paragraph of [ADR 0008](0008-write-without-delete.md). Nothing is implemented yet: win32 still fails closed with "sandbox is unsupported on win32". The first step is the spike in [Spike before implementation](#spike-before-implementation).

## Problem

Windows has no sandbox backend, so confined subagents, background tasks and Main (when enabled) fail closed. ADR 0010's native design proved its file rules but cannot run real tools: under a restricted token, a child with piped stdio fails with `EPERM`, so git, npm and python cannot run. That path is shelved, not solved.

What gets confined is narrow ([ADR 0007](0007-trusted-runtime-task-boundary.md), [ADR 0009](0009-guarded-and-trusted-subagent-tools.md)): the trusted Pi child is never sandboxed. Only three kinds of process are wrapped: task bash commands, the fixed file worker (`node -e FILE_WORKER`) behind read/write/edit/apply_patch, and background-task commands. They all go through `maybeBuildSandboxCommand` in `sandbox-core`.

## Decision

On win32, the backend `wsl2-bubblewrap` runs every confined process inside a WSL 2 distribution, under the existing Linux Bubblewrap plan. Pi stays a Windows process. The trusted Pi child stays on Windows too. Nothing of Pi or its SDK is installed in WSL.

### 1. Launch path

`buildCommand` returns:

```
wsl.exe -d <distro> --cd <linux cwd> --exec <linux node> <launcher.mjs> <request.json>
```

- `--exec` runs the program directly, without the user's login shell, so no Linux shell startup file runs before the boundary (the ADR 0007 rule).
- The **Linux-side launcher** is a small `.mjs` shipped in each package that vendors `sandbox-core`. It imports the vendored `shared-sandbox-core.ts` (using Node's built-in type stripping) and runs the **unchanged** Linux plan builder inside Linux: `realpath`, symlink hops, home listing, worktree discovery, deny-entry materialization, mask sources and the `/usr/bin` or `/bin` bwrap lookup. Then it spawns `bwrap … --die-with-parent -- <exec> <args>` with inherited stdio (file descriptors are handed over directly, not copied through Node) and exits with the child's status. This is why the argv is not built on Windows: the builder has to see the Linux filesystem, not a view of it through `\\wsl.localhost`.
- The **request** is a JSON file the parent writes into the run's control directory (Windows side, for example `…\control\sandbox-request-<uuid>.json`, reached as `/mnt/c/…`). It holds the translated policy, exec path, argv and environment. Passing it as a file avoids re-quoting arbitrary argv through the Windows command line, where wsl.exe would have to parse it back.
- The launcher adds WSL-only mounts to the plan (see [3](#3-paths-and-the-two-homes) and [7](#7-network-interop-and-the-host-escape-hatches)).

**Distro.** Use the distro named in the sandbox settings (`windowsDistro`). If it is unset, use the WSL default distro, resolved once and shown in `/sandbox`. See [open question 1](#open-questions).

**WSL user.** The distro's default user, which must not be root. A root default user (common on CI images and imported distros) is refused, with a message to set a normal default user.

**Detection, fail closed.** On first need, each Pi process runs one probe and caches the result: `wsl.exe -d <distro> --exec /bin/sh -c '<probe>'`. The probe checks that:

- wsl.exe exists;
- the distro exists and runs as WSL 2 (a real kernel: `/proc/sys/kernel/osrelease` contains `WSL2`);
- the user is not root;
- bwrap exists in `/usr/bin` or `/bin`, is root-owned and is not group- or world-writable;
- `bwrap --ro-bind / / --unshare-net /bin/true` succeeds, which proves unprivileged user namespaces work;
- Node ≥ 22.18 is available (type stripping).

Any failure makes `selectedSandboxBackend` return nothing, with a reason that names the fix, for example `wsl --install`, `wsl --set-version <distro> 2`, `sudo apt install bubblewrap`, or install Node 22.18+ in `<distro>`. wsl.exe prints its own messages in UTF-16LE, and the probe decodes them. The first probe may start the WSL VM, which takes about 1–3 s. After that, it costs nothing.

**Stdio.** wsl.exe runs with the user's normal token and relays its standard handles to the Linux process. Pipes on the Windows side are ordinary pipes, so ADR 0010's named-pipe failure cannot occur: it came from the restricted token, and there is none here. This is well-established behaviour (`wsl ls | findstr`, editor and CI tooling rely on it), but it is a claim until the spike proves it for the harness's own uses:

- binary and large (≥ 20 MB) stdout, with no CRLF translation;
- stdin EOF reaching the file worker;
- exit codes and signal deaths;
- a log file handle passed as stdout (background tasks);
- a killed wsl.exe taking the whole Linux tree with it.

`--die-with-parent` covers the last point once the launcher dies. The spike must show that the launcher dies when wsl.exe is killed (`taskkill /T`, and Pi exiting).

### 2. Workspaces and performance

`/mnt/c` is DrvFs, served over 9P from Windows. Many-small-file work there (git status, npm install, test runs) is much slower than on the distro's ext4 disk. It also mixes platforms: a `node_modules` installed by Windows npm holds win32 native binaries (esbuild, rollup, sharp) that Linux Node cannot load.

- **Subagents** default to a `git_clone_workspace` **inside the WSL filesystem**, under a dot folder of the WSL home (for example `~/.pi-better/workspaces/<id>`), so it is removable under Write by the existing rules. The harness runs the clone itself with the distro's git (`wsl.exe --exec git clone --reference-if-able /mnt/c/<checkout> --dissociate <remote> <target>`). This is a trusted step, outside bwrap. The trusted Pi child on Windows uses `\\wsl.localhost\<distro>\…` as its cwd.
- **Main and background tasks** work in place, and their workspace is usually a Windows checkout under `/mnt/c`. This works, with two costs: slower I/O, and Windows-installed native dependencies that may not run under Linux. It is also limited by the enforceability question in [4](#4-write-vs-delete-and-what-drvfs-changes). A user who needs Windows-native tools for a task turns the sandbox off for it (see [open question 4](#open-questions)).

### 3. Paths and the two homes

**Translation.** A pure, cross-platform function maps paths between the two sides:

- a drive path (`C:\Users\x\proj`) becomes `<automount root><drive letter, lowercased>/…` (`/mnt/c/Users/x/proj`). The probe reads the automount root, because `/etc/wsl.conf` can change it;
- `\\wsl.localhost\<distro>\…` and `\\wsl$\<distro>\…` for the configured distro become the Linux path;
- other UNC paths (network shares) and other distros are refused.

The policy sent to the launcher is fully translated. The guarded file operations translate the model's path, which may be in Windows or Linux form, before their lexical check and before handing it to the worker. The kernel (bwrap in WSL) stays authoritative, as ADR 0007 already says.

**Home is the WSL Linux home** (`/home/<user>`). It is the policy's `home`, so everything in ADR 0008's Linux fallback applies to it unchanged:

- dot entries, worktree folders and `/tmp` are writable, including removal;
- ordinary top-level folders and home itself are read-only;
- the fixed credential list is masked;
- code that runs later is read-only.

Linux tools inside use this home and its config (`~/.gitconfig`, `~/.ssh`, `~/.npmrc`), so the existing lists are the right ones. The task's private scratch and `TMPDIR` live in WSL `/tmp`, not in Windows temp.

**The Windows profile is hidden.** The launcher mounts an empty tmpfs over `<automount>/c/Users`, which covers every profile, and then binds back only the workspace when it lives there. That one mount covers everything on the Windows side that the native design had to list one by one:

- `.ssh`, `.gitconfig` and the credential folders under `%APPDATA%`;
- the DPAPI keys;
- the PowerShell profiles and the Startup folder;
- harness state and the run registries under `%LOCALAPPDATA%\Temp`;
- Pi's installed runtime code.

It also sidesteps the case-insensitivity problem below for everything except the workspace. The rest of each drive (`C:\Windows`, `Program Files`, `D:\`) is read-only through the usual `--ro-bind / /`, as `/` is on Linux. Registry autostart keys need no rule, because the registry is reachable only through Windows programs, and interop is blocked (see [7](#7-network-interop-and-the-host-escape-hatches)). See [open question 2](#open-questions).

### 4. Write vs delete, and what DrvFs changes

Bind mounts are enforced by the Linux VFS, above any filesystem. On DrvFs, as on ext4:

- a read-only bind refuses writes;
- a mount point cannot be renamed or removed (`EBUSY`), so the anchors keep working;
- a writable bind allows removal. Linux cannot separate removal from writing.

So Windows gets exactly the Linux fallback semantics, gaps included:

- **Project files = Write is refused at launch**, with the Linux message (use Write & delete or Read). Outside project = Write means the Linux profile: sibling repositories in WSL home are read-only, and removal inside dot folders and temp is unrestricted.
- **Mask sources** (the empty mode-000 file and folder) are created in WSL `/tmp`, never on DrvFs. Without the `metadata` mount option, DrvFs ignores `chmod`.
- **Case-insensitive names are the open risk.** By default (`case=off`), every NTFS folder under `/mnt/c` is case-insensitive, but the Linux dentry cache is case-sensitive. A protected entry inside a writable `/mnt/c` workspace (`.pi`, `.env`, `.git/hooks`, the harness `denyWrite` paths) is a mount on the `.pi` name. `.PI` may reach the same NTFS file through a different dentry that carries no mount. That would be a write escape: the trusted Windows Pi reads `.pi` case-insensitively. **The spike must test this** for files and folders. If variants bypass the mount, a writable `/mnt/c` workspace that contains a protected entry is refused. Read and Off projects there remain allowed, and so do WSL-filesystem workspaces, which are case-sensitive ext4. Per-folder case sensitivity cannot fix an existing checkout: `fsutil … setCaseSensitiveInfo` needs admin and an empty folder.
- **Links.** NTFS symlinks and junctions appear as symlinks in WSL. The builder's hop resolution follows them with the Linux `readlink`, and the spike checks that junction targets translate. A symlink that a task creates on DrvFs is a WSL-only reparse point that Windows programs do not follow, which is the safe direction.
- Landlock is not relied on. Whether the WSL kernel enables it is not known, and nothing here can apply it anyway (ADR 0008).

### 5. Tools and runtime inside WSL

- **Confined processes run Linux programs from the distro:** git, node, npm and python are the distro's, not the Windows ones. Bash commands run under the distro's `/bin/bash`, never the Windows-side shell setting (Git Bash, pwsh). Background-task shell commands run as `/bin/bash -lc` in WSL.
- **Environment.** The launcher builds a Linux environment instead of forwarding the Windows one:
  - `PATH` is the distro default (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`), never the Windows `PATH`;
  - `HOME` is the WSL home, and `USER`, `LANG` and `TERM` are set;
  - `TMPDIR`, `TMP` and `TEMP` point to the scratch;
  - the tool's own `env` values pass through unchanged, and Windows-only variables are dropped.

  The environment travels in the request file, not through `WSLENV`.
- **Pi's runtime in WSL** is only the Linux Node (≥ 22.18). It runs the launcher and the fixed file worker, whose `execPath` becomes the Node the probe found, not Windows `node.exe`. The launcher script is read from the installed package over `/mnt/c`. It runs outside bwrap and is hidden from the task by the profile mount, so a task cannot tamper with it.
- **The POSIX assumptions in the adapters get a WSL branch.** Today they use `/usr/bin/env -i` as the exec wrapper, `/bin/bash`, and a negative-pid process-group kill. The kill becomes killing wsl.exe with its tree.
- **Requirements:**
  - Windows 10 22H2 or Windows 11, with WSL 2 (the Store WSL is recommended);
  - a distro with bubblewrap and a non-root default user;
  - Node ≥ 22.18 in the distro.

  No koffi and no native helper.

### 6. Cost per launch

Each confined command, and each file operation, starts wsl.exe, the Linux Node and bwrap. The first launch after the VM has gone idle pays the VM start. The spike measures the warm per-call cost. If file operations turn out too slow, a follow-up keeps one worker per task alive in WSL. That is not part of this design.

### 7. Network, interop and the host escape hatches

- **Network Off is enforced**, unlike in ADR 0010: bwrap's `--unshare-net` works on the WSL 2 kernel.
- **Windows interop is blocked.** Inside WSL, running any `.exe` (`cmd.exe`, `powershell.exe`, `reg.exe`) starts a Windows process with the user's full token, outside the sandbox. The launcher closes this door three ways:
  - it mounts tmpfs over `/run/WSL`, which holds the interop sockets;
  - the environment has no `WSL_INTEROP`;
  - a fixed seccomp filter (`bwrap --seccomp`, precompiled for x86_64 and aarch64) refuses `socket(AF_VSOCK, …)`, because vsock reaches the host and is not scoped by network namespaces.

  It also hides `/mnt/wsl` (shared across distros) and `/mnt/wslg`. **The spike must show** that `cmd.exe`, `powershell.exe`, a full-path `/mnt/c/Windows/System32/cmd.exe`, `/init`, and a raw vsock connect all fail. If interop cannot be blocked per launch, the fallback is to require a distro with `[interop] enabled=false` in `/etc/wsl.conf`, which is why [open question 1](#open-questions) matters.
- **Carried over from Linux:** a Unix socket reachable in the filesystem (for example Docker Desktop's `/var/run/docker.sock` in WSL) is still connectable through a read-only bind. That is the same gap as on Linux, and it is not addressed here.
- **Recovery snapshot:** none on Windows. Volume Shadow Copy needs admin, and a WSL ext4 disk has no cheap snapshot. `takeRecoverySnapshot` stays macOS-only.
- **`/sandbox` on Windows** shows:
  - the backend "WSL 2 + Bubblewrap", with the distro, WSL user, bwrap path and Node version;
  - or the failing requirement and its fix.

  The README Platforms table gets a Windows column that reads "as Linux". It adds that the Windows profile is hidden except the workspace, that Network Off is enforced, and the `/mnt/c` limits from [2](#2-workspaces-and-performance) and [4](#4-write-vs-delete-and-what-drvfs-changes).

### 8. What is dropped

- The restricted-token, harness-SID and DACL design of ADR 0010, the koffi launcher and ACL applier, `/sandbox windows repair|remove`, and the Windows credential, code-that-runs-later and registry lists. The profile mount makes the lists unnecessary.
- `packages/sandbox-core/windows-plan.ts` and its tests **should be deleted** before this PR merges. The plan compiler is inert and unreachable from any consumer, and nothing in this design uses its SIDs, ACEs or win32 containment rules. Git history keeps it (commit `f52a0ad`). The WSL path translation is new code, not a reuse of `normalizeWin32`.
- ADR 0010 stays as the record of the spike and of why the native path stopped.

## Spike before implementation

This is a throwaway workflow on `windows-2025`, using `Vampire/setup-wsl` with WSL 2, Ubuntu 24.04, bubblewrap, NodeSource Node 22 and a non-root default user. It must answer:

1. Stdio: pipes, binary and large output, stdin EOF, exit codes, a log file handle as stdout, and kill propagation (`taskkill /T` on wsl.exe, and Pi exit).
2. `bwrap` works unprivileged in that distro (the user-namespace and AppArmor settings on Ubuntu 24.04 under WSL).
3. The case-variant question in [4](#4-write-vs-delete-and-what-drvfs-changes), for a masked file, a read-only file and a read-only folder on `/mnt/c`.
4. The interop and vsock blocks in [7](#7-network-interop-and-the-host-escape-hatches).
5. The profile tmpfs with the workspace bound back, and NTFS junctions seen from WSL.
6. Timing: the cold VM start, and the warm per-call cost for a bash command and a file-worker round trip.

If 1, 2 or 4 fails, stop and return to the user. If 3 fails, apply the refusal in 4 and continue.

## Rejected alternatives

- **Native restricted token** ([ADR 0010](0010-windows-sandbox.md)): its file rules were proven, but a child with piped stdio fails, so real tools cannot run.
- **AppContainer:** it needs the same home-wide ACL walks, it blocks loopback without an admin exemption, many developer tools misbehave inside it, and it would still need a native launcher.
- **WSL 1:** it has no real Linux kernel, so no user or mount namespaces, and bwrap cannot run.
- **Docker or a Hyper-V container:** it needs Docker Desktop (a licence in larger organisations) or the admin-installed Hyper-V feature, and it is heavier per launch. WSL 2 is the same virtualisation, and it is already on most Windows developer machines.

## Test plan

- **Every OS (ubuntu `ci` lane):** path translation units; the launcher's request → bwrap argv, including the WSL-only mounts, the seccomp flag and the Linux environment; `/sandbox` status text. The launcher is Linux code, so its kernel cases also run on ubuntu against a fake `/mnt/c` tree.
- **`windows-wsl-sandbox` job** (new): `windows-2025`, the setup from the spike, and `PI_SANDBOX_REQUIRE_BACKEND=wsl2-bubblewrap`. It runs:
  - the `broad-write.test.ts` kernel cases through the real wsl.exe path;
  - the spike's stdio, interop, profile-hiding and case cases as `node:test` suites;
  - a git, npm and python smoke test inside;
  - the fail-closed messages for a missing distro, WSL 1, a root user and missing bwrap.

  `windows-verify` stays as it is.
- **Can the runners do it?** GitHub-hosted Windows runners have offered nested virtualisation since the move to Dadsv5 VMs in early 2024, and setup-wsl documents WSL 2 on later `windows-2022` images and on `windows-2025`. The spike confirms this first. If WSL 2 does not work there, the job moves to a self-hosted Windows 11 runner. Until then, the Windows side is proven with a fake `wsl.exe` seam and the Linux side on ubuntu, and the end-to-end cases run by hand before acceptance.

## Open questions

1. **Which distro?** Recommended: the user's default distro, overridable in `/sandbox`, because their Linux tools are already there. Fall back to requiring a dedicated distro with interop off only if the spike cannot block interop per launch.
2. **Should tasks see the Windows profile at all?** Recommended: no, hide it except the workspace. Reconsider a read-only view only if the spike shows that case variants cannot bypass masks.
3. **Writable workspaces on `/mnt/c`?** Recommended: subagents default to a clone inside WSL. Writable in-place `/mnt/c` workspaces are allowed only if the case spike passes; otherwise they are refused, and Read stays allowed.
4. **Should confined background tasks and Main on Windows also go through WSL,** even though their commands then run Linux tools against a Windows checkout? Recommended: yes, one backend for all confined work. A user who needs a Windows-native build turns the sandbox off for it.
