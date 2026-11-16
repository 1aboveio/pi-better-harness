# Workload Mutation Components

Issue 808 r4 extends the existing full-runtime workload and external file writer.
It does not run or retry the admission-refused primary or daemon fixtures.

## Implemented

`PI_INCREMENTAL_WORKLOAD=1 PI_INCREMENTAL_MUTATIONS=1` selects an opt-in primary
fixture sequence after its unchanged observation window. The existing external
writer performs theme replacement, byte-identical settings replacement and one
log append. Each step retains actual source-byte/digest receipts, runtime counter
deltas and final-result reconciliation. Append assertions preserve the existing
256-byte identity-probe allowance, exact single-log projection and one event per
display/health fold. Ordinary and repair work remain separately reported.

The same writer supports log replacement, truncation and deletion commands.
These source-fault commands have component tests but are not yet orchestrated
through the full process recovery matrix. Its original metadata-marker protocol
is unchanged and has an actual child-process regression test.

Reconciliation validates exact task ID, workspace, session grouping, terminal
state, final text and cumulative input/output/cost. Historical records must have
the correct workspace/session identities and exact count, with no duplicate rows
or cycling pagination cursors. Counter comparison rejects missing, decreasing
or changed-generation data rather than treating it as zero work.

## Component Evidence

`workload-mutations.test.ts` executes production parser/checkpoint logic for
48/96/192 fixture logs, then append, checkpoint restore, same-path inode
replacement, truncation and deletion. It verifies actual cumulative usage and
final parsed text, repeated-read non-duplication and unchanged sibling totals.

Other tests use actual in-process read-model projections to verify settings-only
zero log-byte/projection deltas, separate repair counts, identity and historical
count rejection, and unrelated scope revision/cursor stability with exact
single-log fold counts. The in-process adapter is explicitly component evidence;
it does not impersonate native sessions or sockets.

The existing diagnostic probe now records per-process sampled peak RSS/CPU,
main-thread GC and sampler callback CPU/time cost. These are diagnostic source
fields, not measured native results. Per-process peaks are not simultaneous
aggregate peaks, and worker-thread GC remains uncovered.

## Remaining Work

Native primary and separately refused daemon runs remain prohibited. Actual
Pi/Server/guardian/runner/socket paths and both operating systems remain
unqualified, as do paired fixed-host measurements of at least ten minutes EACH
workload. No CPU improvement or complete acceptance is claimed.

Source work also remains: full restart/crash/fault-matrix orchestration,
backpressure/resync and zero-I/O UI witnesses, combined control/supervision fault
checks, process-wide diagnostic coverage, paired-report validation and canonical
CI execution. This checkpoint has more remaining work than native execution
alone. All original criteria and thresholds remain in `acceptance-map.json`.
