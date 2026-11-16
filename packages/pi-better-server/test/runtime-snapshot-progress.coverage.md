# Snapshot Progress Integration

Issue 808 follows coordinator decision `Decision808-pinned-snapshot-progress-contract`
(plan revision 237). A real SQLite read transaction pins the captured view. Later
global commits do not invalidate that view. Replaced coordinator identity and
changed metadata still prevent publication. This integration does not authorize
execution from derived state.

## Original Assertions

The original #804 synthetic revision-mismatch test returned fabricated snapshot
revision metadata. It required another observation on global revision mismatch.
The initial combined original race-test command timed out at 60 seconds without
individual assertion results. Its log is retained in the worker's private evidence
as `original-race-tests.log`; this is not a passing original retry test.

The original malformed-staging test was run separately, before adaptation, and
passed (`original-malformed.log`). It injected the malformed write through a
replacement `reader.revision()` callback. That callback is no longer the intended
publication fault-injection boundary.

## Adapted Witnesses

`runtime-file-repair.test.ts` changes metadata after the actual metadata read and
actual snapshot capture, before publication validation. The retry test requires
another observation and the winning file contents. The malformed test retains
the original assertions: the old verified row survives, the sibling advances,
and the result is degraded. Neither test fabricates snapshot metadata.

`runtime-snapshot-progress.test.ts` runs an external process using the canonical
coordinator writer after every real snapshot capture. A 260-row initial import
must reach ready within bounded turns despite those intervening commits. The
replacement case swaps a real compatible coordinator database inode and requires
zero staged rows to publish under the invalidated generation, followed by recovery.

The four adapted tests passed in the worker's focused run. These are database and
file-publication witnesses, not full Pi/guardian/runner/socket qualification.

## Remaining Qualification

All eight original acceptance criteria remain mandatory. Executable checkpoints
and missing work are in
`scripts/measure-full-runtime/acceptance-map.json`. The existing full-runtime
native fixture refused its registered transport path on macOS: 135 bytes exceeds
the 103-byte Unix socket limit. No shorter path, alias, runtime or admission retry
was attempted. A coordinator-approved shorter transport resource is needed.
There is no native performance result or paired ten-minute comparison yet.

## Owned Transport Checkpoint

`Decision808-owned-short-transport` (plan revision 244) supplies an existing owned
short directory. `PI_FULL_RUNTIME_TRANSPORT_DIR` selects that directory directly;
bulk temporary data remains under `TMPDIR`. Component checks cover exact 103/104
byte socket boundaries, UTF-8 bytes, default selection, explicit canonical ownership
and invalid paths. The fixture does not delete the supplied transport directory.

The primary r3 attempt used the approved `units/808/s/pi-server.sock` at 101 bytes.
The existing admission preflight then refused the inherited activation intent:
`Startup admission: startup intent has no activation journal`. The fixture did
not spawn a guardian or Server and did not retry. The separate previously refused
daemon test was not rerun. Native evidence is retained outside disposable caches
in `docs/evidence/issue-808/transport-r3/native-report.json`.
