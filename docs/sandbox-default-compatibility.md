# Sandbox default compatibility restoration

Status: implementation and focused kernel tests complete; full verification, independent review, and final session replay pending. No PR until the session gate below passes.

## Baselines

The original write-only sandbox (harness 0.3.20 / subagents 0.2.0, shared core at `3f81dfb`) allowed reads, commands and network, plus writes in the project, macOS `/private/var/folders`, `/private/tmp`, `/dev`, and `~/.pi`. Linux exposed `/` read-only and rebound the project and `/tmp` writable.

Permission profiles (`ae0ce19`, PR #307, harness 0.4.0) introduced project Read/write, outside Read, credential files Read, commands On and network On. In this mode macOS retained `/dev` but removed broad temporary/cache and Pi-state writes.

Trusted runtime separation (`6a5bc71`, PR #308, harness 0.5.0) restored Pi settings/authentication locks, provider transport and session persistence outside task confinement. Task operations use a guarded executor and private scratch. It did not restore literal `/tmp` writes or macOS Keychain's MDS lock access.

## Behavior inventory

| Surface | Original default | Current profile default | Restoration/verification requirement |
|---|---|---|---|
| Project files | Read/write | Read/write except protected paths | Retain; test read/write/edit and shell syscalls |
| Ordinary outside files | Read; no writes | Read; no writes | Retain, including arbitrary `*.lock` files |
| macOS Keychain | Worked incidentally through broad cache grant | Retrieval restored through current-user MDS runtime exception | Actual SDK synthetic-Keychain regression now passes; real safe GitHub replay pending |
| `/tmp` and `/private/tmp` | Writable runtime space | Explicit runtime exception restored when Outside is Read or Read/write; private TMPDIR retained | SDK file and shell tests pass; credential/control exclusions take precedence |
| Current-user macOS temp/cache trees | Entire `/private/var/folders` writable | Current user's discovered T and C/mds only | Other caches and other users remain outside-write denied; reject unsafe path discovery |
| Pi settings/auth/session state | Task and runtime could write `~/.pi` on macOS | Trusted runtime can write; tasks cannot mutate protected runtime files | Preserve trust split; no global task `~/.pi` grant |
| Credential files | Ordinary outside files read-only; Pi auth writable under legacy exception | Explicit credential-file Read, stricter runtime precedence | Preserve explicit credential-file semantics |
| OS vault writes | Not governed separately | Not governed by credential-files row | Do not claim this work enforces read-only Keychain APIs |
| `/dev` | Writable | Writable | Retain shell/null/pipe behavior |
| Commands / network | Allowed | Allowed by default; can be disabled | Retain task enforcement; provider runtime remains independent |
| Task environment | Inherited | Inherited inside confinement; launcher environment minimal | Preserve tokens and command environment without pre-sandbox loader execution |
| Backend lookup | PATH-based Bubblewrap | System Bubblewrap only | Preserve hardening; do not restore PATH hijacking |
| Shell lifecycle | SDK process adapter | Direct wrapper plus SDK drain/tracking | Retain startup confinement, output draining, abort/timeout/shutdown cleanup |
| File operations | SDK host operations under whole-process boundary | Fixed kernel workers with 8 MiB cap | Retain confinement and documented cap; do not imply unchanged size behavior |
| Extension/MCP/SSH/background/nested tools | Previously available by extension selection | Only verified read/write/edit/bash admitted under enabled profiles | Intentional safety restriction; not restored by filesystem exceptions |
| `apply_patch` shell command | No documented shell binary guarantee | Not supplied as a shell command | Classify as unavailable command; use available guarded file operations |
| Paths outside assigned workspace | Write denied except legacy runtime locations | Write denied | Wrong workspace/output targets require corrected paths, not broader file permission |
| Offline package cache misses | Offline dependency availability required | Same | Dependency failure; never label as fixed by sandbox changes |

## Reproduction evidence

- Parent `gh api repos/1aboveio/fmm-express --jq .full_name` succeeds; replay through the recorded child policy returns 404.
- Parent `gh auth status` selects the macOS keyring. Confined token lookup fails; token contents were never printed.
- An allow-default Seatbelt profile succeeds; adding `deny file-write*` reproduces failure.
- macOS kernel logs name `security` denial of `file-write-data` on the current user's `C/mds/mds.lock`.
- A disposable Keychain containing only a synthetic secret reproduces the failure. The integrated SDK test now passes with the full current-user MDS runtime exception. A literal lock-only grant was rejected as incomplete: Apple also creates the directory and updates databases for cold/refresh paths.

Apple source: [MDSSession.cpp](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_mds/lib/MDSSession.cpp). Discovery uses fixed `/usr/bin/getconf` with a minimal environment; `TMPDIR` does not relocate Security.framework's MDS cache. Tests cover missing runtime directories through policy seams and actual synthetic Keychain retrieval on the current warmed OS cache. No real user's cache is cleared to manufacture a cold state.
- Session children also fail redirects to `/tmp/1127-install.log`, `/tmp/resume-1128-install.log` and `/tmp/resume-1129-install.log`.
- After redirecting inside the workspace, one offline pnpm command still reports `ERR_PNPM_NO_OFFLINE_TARBALL`; that is a separate dependency problem.

## Mandatory pre-PR session gate

After the implementation and regression suite, replay safe representatives of errors from:

- `01a0dfb2-b77a-762f-b8e3-1a8e5427ee6d` — KYC.
- `01a0dfb1-e87e-7312-aa91-08f26dcad94b` — FMM Express.
- `01a0dfb8-46fe-73d4-8ed7-d9a4b127b289` — A1.

Record original evidence IDs, policy/cwd, safe replay, result and unresolved category. Do not replay product mutations, overwrite findings, reset credentials, or restart other sessions. Do not claim a historical observation is resolved merely because a different operation succeeds. No PR may be opened until this audit is complete.
