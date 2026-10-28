# Application and shell controls

## Status

Accepted. Extends the trusted runtime and confined task boundary in
[ADR 0007](0007-trusted-runtime-task-boundary.md).

## Context

A single command switch cannot express the choice to run applications without
exposing a shell-command interface, or impose a maximum on each command. These
controls restrict task interfaces; they do not turn Pi or installed extensions
into untrusted code.

## Decision

Keep `commands` as the master application switch, displayed as **Run applications**.
Add optional `shell` and `commandTimeoutSeconds` fields to the existing version 1
permission profiles. Legacy profiles interpret missing fields as `true` and
`null`. Fresh Sandbox switches remain Off; shell scripts default On and commands
have no policy time limit.

With applications enabled and shell scripts disabled, guarded `run_application`
spawns an executable and argument array directly inside the OS sandbox. Shell
commands and explicit shell-interpreter launches, including aliases, are refused.
The fixed launcher uses Node's native `process.execve` rather than `env` or
`execvp`, so executable names cannot become environment assignments and an
unsupported executable cannot fall back to a shell. Direct execution requires a
Node runtime with `process.execve` (22.15+ or 24+); older runtimes fail closed.
A confined subagent requesting `bash` receives the direct application capability
instead, subject to excluded tools; a read-only selection remains read-only.
Background tasks may use direct `shell:false` argv launches but not shell commands.

A configured command time limit is an immutable maximum, even if a model omits
or requests a larger timeout. A smaller requested timeout wins. Background
watches apply the cap to each actual check, not to the whole watch duration.
Subagent and background launches snapshot their policy; existing work retains its
launch policy, including across reload for background tasks. Restrictive policies
reject incompatible older consumers rather than silently dropping restrictions.

## Boundary and consequences

This is an intentional restriction on the exposed interface, not a proof that no
shell can execute. Applications such as `pnpm` and `pytest` can invoke scripts or
shells internally, and applications are not guaranteed to terminate without a
configured limit. Timeout cleanup covers ordinary process-group descendants, not
a deliberately daemonized process that escapes the group.

Pi, provider code, and installed runtime extensions remain trusted as described
in ADR 0007. The application control does not constrain arbitrary trusted runtime
code or remote effects. File and network permissions remain separate controls.
