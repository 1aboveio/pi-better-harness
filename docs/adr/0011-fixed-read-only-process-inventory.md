# Fixed read-only process inventory

## Status

Accepted. Extends [ADR 0007](0007-trusted-runtime-task-boundary.md)'s fixed task
adapters and [ADR 0005](0005-sandbox-permission-table.md)'s human permission table.

## Context

Local diagnostics can need process inventory before starting an emulator or
allocating test resources. On macOS, setuid /bin/ps can fail at exec under
Seatbelt even with process-info reads allowed. Repository profiles do not
explicitly deny all process information. A broad process-exec no-sandbox grant
would abandon the task boundary and is not an acceptable fix.

## Decision

Add Process access with Off and Read values, persisted as `processAccess`.
Fresh Main and Subagents profiles default to Read. Absent values in saved
profiles decode to Off, and explicit saved values are preserved. Existing
profiles are not broadened. Subagents
capture the selected value in their immutable launch policy.

The fixed `process_list` tool returns current-user PIDs and process names only.
Inputs can select a literal name substring and a bounded result limit; they
cannot supply executable paths, commands, regexes, target users, environment
values, or process-control operations. Signals, debugger attachment, full
arguments, environment reads, emulator actions, and database allocation are
not part of this adapter. Normal process races do not constitute a stable
snapshot or prove the absence of a resource.

Use the system's non-setuid /usr/bin/pgrep through the existing kernel policy.
No shell, PATH resolution, fallback to /bin/ps, copied privileged executable,
or no-sandbox execution grant is allowed. Only the helper's own process may be
terminated on cancellation, timeout, or excessive output. Like the fixed file
worker, the adapter can execute while general commands are Off; network is
disabled for the helper and existing file/credential rules are retained.

## Limits

Process access governs the fixed tool, not all OS process syscalls. Existing
arbitrary command or trusted-extension permissions may permit other process
inspection or control; this change does not claim to restrict them. Windows
is unsupported; missing or unusable system helpers fail explicitly.

## Verification

Exercise Off/Read gating, migration, immutable launch snapshots, replacement
tool refusal, bounded metadata and literal filtering, malformed input, errors,
cancellation, and actual confined inventory against test processes. Verify
the real terminal control and package the shared adapter with both consumers.