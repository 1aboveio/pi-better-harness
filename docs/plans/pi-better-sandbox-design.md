# pi-better-sandbox design

Authority: product decisions captured in epic
[#229](https://github.com/1aboveio/pi-better-harness/issues/229); existing Linux
sandbox ADR `packages/pi-better-subagents/docs/adr/0001-linux-sandbox-bubblewrap.md`;
shared-package precedent `docs/adr/0002-ssh-core-shared-package.md`.

Status: **proposed design - tracked as epic #229**.

## Problem

Pi's foreground shell and file-mutation tools currently run with normal host
write access. `pi-better-subagents` already confines detached children with
macOS `sandbox-exec` or Linux Bubblewrap, but its implementation is embedded in
the subagent package and cannot be reused by foreground tools or local
background tasks.

The foreground needs a default-on write sandbox without a separate launcher,
per-project permission databases, or read-access configuration.

## Product contract

Users continue to launch Pi normally:

```sh
pi
```

Installing `pi-better-sandbox` loads a Pi extension. The harness meta package
loads it by default. At every session start, the extension canonicalizes
`ctx.cwd` and captures it as `PROJECT_ROOT`.

While enabled:

```text
Read:       every filesystem path
Write:      PROJECT_ROOT and descendants
Exceptions: canonical paths in denyWrite
```

The sandbox starts enabled after startup, new session, resume, fork, and reload.
An off state is never persisted. Reads and network remain unrestricted.
Toggles affect operations launched after the state change; already-running
background tasks retain the policy they had when they started.

This is a **tool-execution sandbox**. Pi's own process, arbitrary `pi.exec`
calls, and unrelated third-party extension code are not confined.

## User interface

Commands:

```text
/sandbox
/sandbox on
/sandbox off
/sandbox deny list
/sandbox deny add <path>
/sandbox deny remove <path>
/sandbox deny reset
/sandbox rules
```

`/sandbox` reports the backend, canonical project root, fixed read policy,
writable root, concrete denied paths, and integration status. The footer shows
`sandbox - on - <project>` or a visually prominent `sandbox - OFF` state.

`/sandbox off` requires interactive human confirmation and is rejected without
an interactive UI. There is no LLM-callable tool for changing sandbox state or
rules. `/sandbox rules` and the deny subcommands use the same validation and
persistence module.

## Write-denied paths

Rules contain paths only. There are no per-rule read/write modes and no semantic
command-risk rules.

Packaged defaults:

```text
${PROJECT_ROOT}/.git/hooks
${PROJECT_ROOT}/.env
${PROJECT_ROOT}/.env.local
```

Relative entries resolve against `PROJECT_ROOT`; `~` resolves against the
user's home. Every entry is canonicalized before validation, enforcement, and
display. A directory denies writes to its subtree; a file denies writes to that
exact file.

Installation does not materialize a settings file. The extension creates a
user override only after a rule changes. `deny reset` removes the override and
restores the defaults shipped by the installed package.

The override is one global template set, not a per-project database. A relative
entry is stored as a `PROJECT_ROOT`-relative template and therefore applies to
the same relative path in every project.

Launching from `/`, the user's home directory, or another configured unsafe
broad root must not silently grant that location write access. Protected
operations fail closed and explain how to launch from a narrower directory or
explicitly disable the sandbox.

## Architecture

```text
                    packages/sandbox-core
                 private shared mechanism
           backend selection, paths, profiles, argv
                              |
                    vendored into consumers
             +----------------+----------------+
             |                |                |
             v                v                v
  pi-better-sandbox  pi-better-subagents  background-tasks
  foreground policy  detached-run policy  local task policy
  tools and UI        lifecycle/metadata    durability/UI
```

### `packages/sandbox-core`

The private module owns:

- backend discovery and support diagnostics;
- canonical path, containment, and deny-path compilation;
- macOS SBPL profile construction;
- Linux Bubblewrap mount construction;
- ordered executable/argv wrapping without shell interpolation;
- fail-closed versus explicitly disabled launch planning;
- injectable platform/filesystem dependencies for deterministic tests.

It does not own Pi commands, TUI state, settings, tool registration, background
task lifecycle, or subagent policy.

Distribution follows the implemented `ssh-core` pattern: private workspace
source of truth, generated vendored copies in publishable consumers, and sync
steps in consumer `pretest`/`prepack` scripts.

### `pi-better-sandbox`

The publishable extension owns:

- enabled/disabled foreground state;
- slash commands and compact status UI;
- deny-write defaults and user overrides;
- built-in `bash`, `write`, and `edit` overrides;
- user `!` / `!!` routing through `user_bash` operations;
- publication of immutable effective policy to first-party consumers.

Use `pi.events` for session-local state needed by other harness extensions. The
event contract exposes effective policy and status, never arbitrary execution.

### Existing consumers

`pi-better-subagents` becomes a consumer through a thin adapter. Its existing
tool parameters, default-on/best-effort policy, explicit-request behavior,
metadata, and process lifecycle remain unchanged during extraction.

`pi-better-background-tasks` consumes the effective foreground policy for local
spawn/watch commands. Structured remote SSH execution retains its existing
remote semantics.

## Protected execution paths

Enabled mode covers:

1. Pi's built-in `bash` tool.
2. User-entered `!` and `!!` commands.
3. Pi's built-in `write` tool.
4. Pi's built-in `edit` tool.
5. Local background-task spawn/watch commands.
6. Subagents through the extracted shared mechanism.

Built-in overrides retain Pi's schemas, result details, renderers,
file-mutation queue behavior, cancellation, timeout, truncation, environment,
and process-tree termination contracts.

## Failure policy

When enabled, absent or failed backend initialization blocks protected
operations. A selected backend never retries an operation unsandboxed. The
operator may consciously use `/sandbox off` through interactive confirmation.

Status surfaces distinguish `enabled`, `disabled`, `unavailable`, and `failed`;
they must never present configured intent as active kernel enforcement.

## Acceptance criteria

1. `pi-better-sandbox` installs standalone and loads by default in the harness.
2. The product ships no launcher executable; users invoke ordinary `pi`.
3. Enabled state is restored on every session lifecycle start and reload.
4. Canonical launch cwd is the sole writable project root.
5. Reads outside the root and existing network behavior continue to work.
6. Sandboxed processes cannot write outside the root or leave a host artifact.
7. Writes inside the root succeed unless their canonical target is denied.
8. Defaults deny writes to `.git/hooks`, `.env`, and `.env.local` under the root.
9. Denial covers create, replace, rename, delete, and directory-subtree writes.
10. Symlinks cannot widen the root or bypass denied paths.
11. `/sandbox` and the footer report effective state truthfully.
12. Disabling requires interactive confirmation and is unavailable to the model.
13. Re-enabling restores policy without restarting Pi.
14. Deny commands and settings UI share canonical validation and persistence.
15. Missing or failed backends fail closed without direct retry.
16. Subagent sandbox behavior remains backward compatible after extraction.
17. Local background tasks honor foreground policy; remote tasks do not change.
18. Built-in tool rendering and result contracts remain intact.
19. Documentation states the tool-execution boundary and excluded extension code.
20. Real macOS and Linux tests prove policy with disposable fixtures.

## Testing strategy

- Move existing subagent sandbox characterization into `sandbox-core` before
  adding behavior.
- Unit-test backend planning with injected platform, PATH, filesystem, and
  canonicalization dependencies.
- Run real `sandbox-exec` checks on macOS CI and real Bubblewrap checks on Linux.
- Drive tool overrides through an ExtensionAPI harness and real filesystem
  fixtures; do not mock first-party internals.
- Add integration coverage for foreground policy propagation to background
  tasks and subagents.
- Test status, confirmation, toggling, path resolution, unsafe roots, and reset.
- Prove a selected backend failure never executes a child directly.

## Delivery order

1. Extract `sandbox-core`, vendor it into subagents, and preserve behavior.
2. Add the `pi-better-sandbox` package, state, status, and slash commands.
3. Override built-in bash and user bash with kernel-enforced execution.
4. Override write/edit while preserving Pi's tool contracts.
5. Integrate local background tasks and inherited subagent policy.
6. Add deny settings UI, docs, harness loading, CI, and release wiring.

The extraction slice is mechanical and behavior-preserving. New security policy
does not ship until both platform backends have real-kernel proof.

## Out of scope

- Filesystem read restrictions.
- Network isolation or domain allowlists.
- Confining Pi's process or arbitrary third-party extension code.
- A separate `pi-better-sandbox` executable.
- Per-session or per-project write allowlists.
- Additional writable roots after startup.
- Windows support in v1.
- Shell-text parsing as the primary security boundary.
- Heuristic protection of every operation inside the writable project.