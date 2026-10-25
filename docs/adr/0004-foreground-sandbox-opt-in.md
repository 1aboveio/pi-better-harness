# Sandbox switches are opt-in for Main, Subagents, and Background tasks

## Status

Accepted, amended by the user's all-Off default request after #572. This
supersedes the original Subagents default-on decision and the default-on
foreground policy in `docs/plans/pi-better-sandbox-design.md`.
ADR 0003's shared mechanism is unchanged. The [ADR 0005 background-tasks amendment](0005-sandbox-permission-table.md#background-tasks-amendment-572)
replaces local background tasks' Main inheritance with an independent profile;
missing profiles migrate from Main without changing existing behavior.

## Context

The foreground sandbox is a tool-execution write guard, not a complete boundary
around Pi. It does not confine Pi's own process, arbitrary `pi.exec` calls, or
unrelated extension code. Default-on also makes ordinary foreground tools fail
closed on unsupported platforms, including Windows, and changes behavior merely
because the harness was installed.

Subagents originally kept a default-on policy because they are autonomous
detached processes. After approving #572, the user requested that every fresh
sandbox switch start Off. Explicit saved profiles and session choices must
retain their activation and detail values.

## Decision

- Main, Subagents, and Background tasks sandbox switches start Off for fresh
  settings. This changes activation only; retained permission details and trusted
  tool defaults are unchanged.
- `/sandbox on` and `/sandbox off` are session overrides.
- `/sandbox default on|off` persists the foreground default. Persisted opt-in is
  reapplied at startup, new session, resume, fork, and reload.
- An enabled sandbox remains fail-closed: an unsupported platform, missing
  backend, unsafe root, or backend initialization failure blocks the operation.
- Inactive mode never blocks because a backend is absent. Status distinguishes
  an available-but-inactive backend from an inactive unsupported platform.
- Local background tasks originally inherited the foreground state captured at
  launch. ADR 0005's #572 amendment replaces this with an independent Background
  tasks profile, still captured at launch.
- The foreground-only `inactive` presentation state is published to extension
  consumers as the existing `disabled` enforcement state, preserving safe
  behavior across package-version skew.
- Without published Subagents settings, an omitted `sandbox` starts unconfined.
  Explicit `sandbox:true` still requests kernel confinement and fails closed if
  it cannot be applied. `sandbox:false` cannot bypass a human-enabled profile.
- Saved global and session profiles remain authoritative, including enabled
  switches. Existing activation-only and missing-Background migration is unchanged.

## Consequences

Installing the harness no longer activates confinement for any of the three
profiles or blocks Windows sessions merely because Subagents defaulted On.
Operators opt in through `/sandbox`, or use `/sandbox default on` or `/sandbox on`
for Main. Standalone subagent callers can request `sandbox:true`. Documentation
and status surfaces must not imply that installation activates kernel enforcement.

## Amendment verification

Verified on macOS after the all-Off default change:

- Sandbox package tests: 236 passed; one Linux-only kernel test skipped.
- Subagent permission policy, catalog inspection, sandbox adapter, and task-runtime
  tests: 44 passed; one Linux-only test skipped. This includes real kernel file,
  command, network, and synthetic-Keychain checks with confinement enabled.
- Focused single/batch launch tests: four passed, covering missing-publisher
  defaults and explicit confinement refusing an unsupported runtime.
- Real permissions TUI tests: all seven passed, including fresh all-Off display,
  explicit activation, session reload, saved enabled profiles, and new sessions.
- `node scripts/run-sandbox-golden.mjs`: ALIVE, all six paths passed. The driver
  installs its task guard explicitly and does not rely on activation defaults.
- Sandbox and subagent task-runtime TypeScript checks and `git diff --check` passed.

A broader batch launch test run has four capacity failures also reproduced from
untouched HEAD before this amendment. Those admission fixtures are unchanged by
this work; focused launch-policy cases pass.