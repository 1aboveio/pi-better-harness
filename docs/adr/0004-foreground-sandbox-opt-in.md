# Foreground write sandbox is opt-in; subagents remain default-on

## Status

Accepted. Supersedes the default-on foreground policy in
`docs/plans/pi-better-sandbox-design.md`; it does not change ADR 0003's shared
mechanism or the subagent policy.

## Context

The foreground sandbox is a tool-execution write guard, not a complete boundary
around Pi. It does not confine Pi's own process, arbitrary `pi.exec` calls, or
unrelated extension code. Default-on also makes ordinary foreground tools fail
closed on unsupported platforms, including Windows, and changes behavior merely
because the harness was installed.

Subagents have a different risk profile: they are autonomous detached processes
with a dedicated writable run directory and an explicit per-call `sandbox:false`
opt-out. Their existing default-on policy remains appropriate.

## Decision

- Foreground shell, write, edit, user-bash, and local background-task execution
  starts unconfined by default.
- `/sandbox on` and `/sandbox off` are session overrides.
- `/sandbox default on|off` persists the foreground default. Persisted opt-in is
  reapplied at startup, new session, resume, fork, and reload.
- An enabled sandbox remains fail-closed: an unsupported platform, missing
  backend, unsafe root, or backend initialization failure blocks the operation.
- Inactive mode never blocks because a backend is absent. Status distinguishes
  an available-but-inactive backend from an inactive unsupported platform.
- Local background tasks inherit the foreground state captured at launch.
- The foreground-only `inactive` presentation state is published to extension
  consumers as the existing `disabled` enforcement state, preserving safe
  behavior across package-version skew.
- Subagents retain default-on, explicit-request, and `sandbox:false` opt-out
  behavior.

## Consequences

Installing the harness no longer changes ordinary foreground write behavior or
blocks Windows sessions. Operators who want foreground confinement opt in once
with `/sandbox default on` or per session with `/sandbox on`. Documentation and
status surfaces must not imply that installing the extension activates kernel
enforcement.