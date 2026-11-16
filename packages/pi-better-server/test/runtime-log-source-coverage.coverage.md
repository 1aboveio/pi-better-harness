# Current Source Coverage

Source808/796 requires explicit completeness under replacement, truncation,
deletion and recovery. ADR0023 keeps raw logs as evidence and derived indexes
reconstructable; index projections do not grant execution authority.

`display.coverage.complete` means the current available source has fully covered
cumulative parser state. Equality of a retained offset and retained byte count is
necessary but not sufficient: the source must be available/readable, with no
parser error, missing range, catch-up or truncated window. A real readable empty
file is complete at offset0/total0. An absent file is not an empty file.

## Controlled RED

On718bec4e, real empty/nonempty logs were seeded and observed, then unlinked.
Both projected complete:true and index ready while detail parsing reported ENOENT.
Replacing a real log with a directory also projected complete:true despite an
actual read error. All three focused assertions failed; original output is retained.
No mocks, runtime services, probes or admission retries were used.

## Cause And Fix

The read model skipped parseRun for a missing signature, but reused hot/checkpoint
state to calculate coverage from old offset==total. Parse errors were also absent
from the completeness predicate. The result could overwrite display usage with
an empty fallback, save failed transient state and remain ready because only
metadata/assignment failures contributed degradation.

The production log-change path now retains the last verified display/health facts,
marks coverage incomplete with a source error, and degrades the existing row.
Transient failed parser states are discarded; durable verified checkpoints are
not rewritten. Valid source recovery uses the existing identity-aware parser and
checkpoint path. The successful predicate also excludes errors and missing ranges.

Archive-only records have no current raw-log promise and retain their existing
ready/no-raw-health behavior. Verified task-directory deletion still removes the
row. Initial raw metadata without a log is unavailable/degraded, not implicitly
an available empty file. Coordinator/metadata-only tests that expected ready now
seed real empty logs; their progress, generation and budget assertions are intact.

No inventory, scan, poll, source writer or checkpoint schema/budget was added.
Degradation is accumulated during the existing row projection loop. Only the
affected source/cache entry changes; unchanged sibling logs and metadata are not
read. Authoritative metadata, assignments and execution states remain separate.

## Reconciliation And Evidence

The workload reconciler now accepts degraded only when the manifest explicitly
expects a missing log and the reason identifies log-source unavailability. It
still rejects complete:true and unrelated degradation. Missing cumulative usage
is null, not an asserted complete zero bill. Present projections must be verified.
Existing capability-missing/notRun recovery states are unchanged.

Focused real-file checks cover empty/nonempty disappearance, unreadable source,
last verified facts, zero sibling bytes/metadata rereads, no unavailable checkpoint
writes, restoration, empty truncation, inode replacement, derived-reader reopen,
initial missing source, verified deletion and committed archive-only membership.
Archive publication is observed before deleting its raw directory; concurrent
metadata-publication races remain a separate original fault-matrix obligation.

This is source/component correctness only. Both-OS native processes, sockets,
supervision/exit and SAME fixed-host >=10-minute EACH paired workloads remain
unqualified. Previous native admission refusals were not retried or bypassed.
