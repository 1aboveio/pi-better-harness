# Mutation and Checkpoint Recovery Flow

Issue 808 r7 extends the existing workload writer/client orchestration only.
It adds no runtime RPC, service, transport, retry loop or timeout change. The
primary, refused daemon, probe, guardian and Server were not launched.

## Declared Sequence

The opt-in workload now records theme, same-settings rewrite, append, checkpoint
eviction, append after eviction, checkpoint restart, append after restart,
replacement, truncation and deletion. Exact task identities come from the seeded
manifest. Every executed step reconciles actual final text, usage, task identities
and historical membership. Existing per-append 256-byte probe allowance and
single-log/fold assertions remain; replacement and empty/missing source reads
have their own source-byte expectations.

Checkpoint control must be supplied by an explicitly scoped fixture-owned hook.
No production eviction/restart API exists on WorkClient, so the primary fixture
records both controls as `missing-capability`, leaves their dependent append steps
`notRun`, and continues independent source mutations. A component control cannot
be treated as runtime authority. Eviction must actually empty measured parser
caches; a receipt alone does not pass. Runtime restart requires a new actual read
instance and fixture client. Recovery counter resets are recorded separately from
ordinary mutation deltas.

Statuses are persisted before execution. Errors stop the sequence once, retain
the failed step, and leave subsequent steps `notRun`. Reporting errors remain
separate from the original writer/control/reconciliation failure.

## Actual Component Observations

Tests use real files, SQLite-derived checkpoints and an in-process WorkReadModel,
not native sessions or sockets. The component eviction clears actual parser maps;
the component restart closes/reopens the derived reader and restores persisted
checkpoints. Final usage after dependent appends is verified without duplicated
charges. These are derived-reader component operations, not a native process
restart or accepted native recovery.

Replacement and truncation reconcile their exact new results. Deleting the empty
log exposes a current source-projection defect: `display.coverage.complete` remains
true while the actual detail parser reports ENOENT. The reconciler rejects that
contradiction with `Missing source cannot claim complete log coverage`. The state
remains failed, not completed. This source failure is recorded separately from
the passing safety-rejection assertions; no production fix or assertion waiver
was introduced in this unit.

At the r8 source checkpoint this specific production defect was corrected after
a controlled real-file RED/GREEN regression. Missing/unreadable raw logs now retain
verified facts as degraded/incomplete without checkpoint writes. The original r7
failure evidence remains historical and unmodified. Reconciliation admits only the
expected missing-log degradation, never unrelated errors or a complete claim.

An unavailable log is distinct from an available empty log. Missing-source
diagnostics are mandatory and reconciled cumulative cost/input/output are null,
never an asserted complete zero bill. A direct actual-file/parser check covers
that classification without emulating a native client.

## Remaining Qualification

The primary fixture has no legitimate runtime eviction/restart hook. It must not
invent one, clear inherited authority or retry a refused runtime. The deleted-log
production fix has component coverage, but its native verification is still unrun.

All original native both-OS, actual-session, fixed-host and at-least-ten-minute
EACH workload criteria remain. Full crash/drop/gap/out-of-order recovery, UI/
subscription/control and worker-GC/queue/event/recovery/exit coverage remain
missing. Real cohort alignment remains unqualified; no timestamp interpolation,
summed separate peaks, CPU improvement or no-progress-history reset is claimed.
