# Confined macOS process identity compatibility

> Historical decision. The current sandbox contract is in [ADR 0027](0027-sandbox-tools-and-permissions.md#execution-boundaries).

## Status

Accepted. Extends ADR 0011's Process Read adapters. Tracked in #834.

## Context

The setuid system `/bin/ps` can fail at exec under Seatbelt. A test connector
registration using `ps -p PID -o lstart= -o comm=` therefore fails despite Process
Read. The fixed process_list inventory cannot substitute for a start identity.
A caller-specific native helper duplicates sandbox compatibility work in each
repository. Experiments under the original worker policy established that
non-setuid proc_pidinfo/proc_pidpath reads work without relaxing confinement.

## Decision

When a confined Main or Subagents command launches on Darwin with Process Read,
the shared task executor prepends a protected directory containing a fixed `ps`
compatibility binary to its task PATH. Only the exact argv form above is
accepted. Querying another user, an exited PID, malformed input, unstable identity
or an unavailable executable path fails without producing a partial identity.
The helper compares two kernel start-time samples including microseconds and
executable paths; output preserves system ps lstart/comm formatting. The text
format retains the original second precision and is not a durable process handle.

The trusted runtime compiles fixed literal C source once per control directory
using fixed /usr/bin/clang arguments, a minimal environment, a 15-second deadline,
and a 64-KiB output budget. Only the compiler's owned group may be stopped on
budget failure. The task cannot choose source or compiler. A private subdirectory
of the existing protected control directory owns the helper; the task policy
allows that narrow directory to be read but denies writes. The executor checks
mode, ownership, canonical location and content integrity on reuse. Main's
policy is rechecked after asynchronous preparation; an intervening policy change
refuses the launch. Session control-directory retirement removes the helper.

Compiler failure installs a fixed unavailable response instead of broadening
execution or blocking unrelated commands. Xcode Command Line Tools and a session
restart are required to recover. This dependency and the limited argv contract
must be visible in the sandbox documentation.

No setuid executable is copied and no process-exec no-sandbox rule is introduced.
The helper inherits task kernel confinement. No signals, arguments, environment,
regex filters, target-user selection or arbitrary executable entry is exposed.
The process_list adapter remains unchanged, including its ability to run with
Commands Off. Linux and Background command execution remain unchanged.

## Limits

Absolute /bin/ps and scripts that replace PATH are outside this compatibility
entry. Unsupported ps forms fail explicitly; it is not a general ps replacement.
Process Off prevents installation for new command launches, not every process
syscall or direct execution of an already-known helper by a task that can run
arbitrary code. Already launched task processes retain their inherited policy.
The runtime and installed extensions remain trusted as specified by ADR 0007.

## Verification

Exercise the unchanged Node call through the production command executor; compare
its output with system ps, retain the raw /bin/ps EPERM control, and verify helper
write denial under broad grants and Outside Off. Cover Process Off, Commands Off,
unsupported arguments, foreign/exited PIDs, integrity failure, concurrent reuse,
compiler unavailability, policy changes and standalone package contents. Replay
the original Quick Tunnel caller without the caller-specific replacement patch.
