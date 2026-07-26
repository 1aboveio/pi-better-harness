# Linux write-sandbox backend: bubblewrap

Status: accepted

Refs #5 (decision record only — implementation follows separately)

## Context

Subagent children get kernel-enforced write confinement via macOS
`sandbox-exec` (SBPL); `sandboxSupported()` returns `true` only on `darwin`.
On Linux the default-on sandbox silently degrades to no confinement and
explicit `sandbox:true` / `sandbox_dir` requests throw, which blocks running
the integration queue gate on `ubuntu-latest` runners and leaves Linux hosts
without parity (#5). We needed a Linux backend that preserves the current
spawn shape (`file` + `fileArgs` wrapper around the pi argv), needs no root,
and works on GitHub-hosted runners.

## Decision

- The Linux backend is **bubblewrap (`bwrap`)**, discovered from `PATH`.
- `sandboxSupported()` returns `true` on Linux only when a viable `bwrap`
  executable is available.
- **No backend available:** an explicit `sandbox:true` / `sandbox_dir` request
  errors clearly; default-on degrades to unsandboxed, preserving the current
  policy.
- **Backend present but init/spawn fails:** fail closed, even for default-on.
  Once `bwrap` was detected we never silently retry unsandboxed.
- Confinement shape: the Linux root filesystem and `~/.pi` are readable but
  read-only. Writable paths are the selected writable workdir and host `/tmp`;
  `/dev` remains usable. Reads and network remain unrestricted/shared — we do
  **not** unshare the network, so the model API and `web_fetch` keep working.
- macOS `sandbox-exec` behavior is unchanged.
- Windows remains out of scope.

## Considered options

- **Landlock helper** — pure-syscall LSM (kernel ≥ 5.13), the closest
  conceptual parallel to SBPL, but it needs a separate helper binary, a
  fallback story for older kernels, and cannot express the bind/remount
  topology we want. Rejected for now; a future ADR could add it.
- **Direct user/mount namespaces** (`CLONE_NEWUSER`/`CLONE_NEWNS`) — no extra
  binary, but fragile across distros and CI images where unprivileged user
  namespaces are restricted; essentially reimplementing bubblewrap badly.
- **Backend chain** (try bwrap → landlock → namespaces in order) — multiple
  backends multiply the failure matrix and test surface for no user-visible
  gain; a single well-known backend with explicit no-backend semantics is
  simpler to reason about and to test.
- **Docker/Podman** — far too heavy for per-subagent spawn (daemon, image
  pulls, cold start). Rejected outright.

## Consequences

- Linux gains the same syscall-level write confinement macOS has, with one new
  external dependency (`bubblewrap`) that must be installed on hosts/CI.
- `~/.pi` being read-only on Linux differs from macOS (where the SBPL profile
  allows writes there); Linux children must direct pi state/temp to the
  writable workdir or `/tmp`.
- The degrade-vs-throw policy is unchanged in shape but gains a third state:
  "backend detected yet failed" fails closed instead of degrading.
- CI installs bubblewrap and moves the integration runner to `ubuntu-latest`.

## Failure matrix

| Situation | Explicit `sandbox:true` / `sandbox_dir` | Default-on |
|---|---|---|
| No `bwrap` on `PATH` | Error (clear message) | Degrade to unsandboxed |
| `bwrap` detected, init/spawn fails | Error (fail closed) | Error (fail closed) — never retry unsandboxed |

## Writable-path invariant

The writable workdir is canonicalized (symlink-resolved) before being bound,
so symlinks cannot expand write access beyond the selected directory. Bind
semantics must ensure that a symlink *inside* the writable workdir pointing at
a read-only outside target cannot be used to write through to that target —
writes follow the bind-mounted view, and the rest of the filesystem stays
read-only.

## Verification obligations

- CI installs `bubblewrap` and switches the integration runner to
  `ubuntu-latest`.
- Deterministic (no model) tests prove confinement both ways: writes inside
  the workdir succeed, writes outside fail.
- `tests/test_env_inherit.sh` passes on Linux (environment, e.g. `GH_TOKEN`,
  reaches the child through the sandbox).
- Real-model smoke: a scoped child completes a model call and `web_fetch`
  (network is shared, not unshared).
- `gh` smoke: a `bash`-scoped child can drive `gh` against this repo.
- Existing macOS sandbox tests (`test_sandbox_applied.sh`,
  `test_sandbox_deny_outside.sh`, `sandbox_profile.test.mjs`) keep passing
  unchanged.
