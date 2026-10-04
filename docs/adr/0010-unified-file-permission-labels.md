# Unified file permission labels and writable subagent credentials

## Status

Accepted. Amends the credential labels and built-in Subagents default in
[ADR 0005](0005-sandbox-permission-table.md) and
[ADR 0008](0008-write-without-delete.md).

## Context

File rows showed Write & delete for saved `read-write` values, while Stored
credentials showed Read / write for the same level. The inconsistent labels
obscured the access being granted. Read-only credential files also prevent some
authenticated CLI queries: gcloud privatizes its credential database with chmod
before opening it, even for a read-only cloud operation.

## Decision

All file rows share Off, Read, Write, and Write & delete terminology. Stored
credentials is a subset of that enum: Off, Read, and Write & delete. It does not
offer Write until that distinct restriction is implemented and verified.
The persisted value `read-write` and its enforcement semantics are unchanged.

The built-in Subagents Stored credentials default becomes Write & delete.
Main retains Read. Explicit global settings and session snapshots are not
migrated or broadened; their saved Off, Read, and read-write values remain intact.
Launches continue to snapshot the effective human-controlled profile.

## Consequences

New default profiles permit tasks to modify and delete known credential files,
not merely authenticate through them. This trade-off supports normal CLI
credential database and token maintenance. Stricter protected-path and explicit
deny rules still override this grant. OS credential services and inherited
environment tokens remain outside the credential-file control's scope.

Write still means removal restricted, not universally prohibited: disposable
directory exceptions and platform limits from ADR 0008 are unchanged.

## Verification

Tests exercise default profile independence, preservation of explicitly saved
credential choices, common labels, three-level credential cycling that skips
Write, and terminal width bounds. Existing kernel credential tests continue to
exercise Off, Read, and read-write enforcement without real credential values.