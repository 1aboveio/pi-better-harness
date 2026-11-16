# Paired Report Validation

The r5 validator audits the existing full-runtime measurement report shape. It
does not run either refused native fixture, create measurements, authenticate a
machine, or grant execution authority. Its result concerns AC7 evidence only,
not all eight acceptance criteria.

Run the existing report files through:

```sh
node --import tsx packages/pi-better-server/scripts/measure-full-runtime/paired-report.mjs \
  BEFORE-REPORTS.json AFTER-REPORTS.json APPROVED-IDENTITIES.json
```

Each input may be one report or an array of reports. The approved identity file
contains `fixedHostId`, the shared `fixtureSha256` and `before`/`after` objects, each with `head`,
`sourceSha256` and `artifactContentId`. These must come from approved actual
source/artifact records, not from values invented to satisfy the validator.
The before head is fixed at `eec7b3e256a7548bbf67f69cd468f12eb3b91dc8`.

## Schema Additions

The collector records `measurement.schemaVersion: 1`, a caller-supplied
`PI_FULL_RUNTIME_HOST_ID`, actual hostname, existing `readOwnBuild()` identity
(or null when unavailable), the fixed sampler/control intervals, active workload
recipe and explicit false flags for missing metric coverage. No runtime context
or settings are changed to obtain those fields.

`measurement.fixtureSha256` hashes the actual workload driver, frontend/hosted
fixture, sampler/tracer, mutation writer/helpers and offline provider source.
It must match the same approved fixture digest on both sides; configuration
equality alone cannot establish unchanged workload or diagnostic implementation.

Each window retains actual `resourceBefore` and `requiredProcesses` identities,
`countersBefore`, wall-clock bounds and monotonic `elapsedMs`. Measurement duration
now excludes final reconciliation. CPU/RSS totals must match all reported related
processes; process start identity, sample generation, worker/coordinator generation,
CPU/I/O monotonicity and the exact declared diagnostic budget are checked.

The existing matrix requires every 4416/10000-history, 1/5/10-client and
48/96/192-group window on BOTH sides, each for at least 600000 ms. The validator
rejects missing or duplicate windows, different hosts/runtime/workloads/budgets,
unapproved or dirty source/artifact identity and missing final reconciliation.
Both sides must use the same fixed host; separate operating systems need separate
host-paired validations.

## Missing Coverage

The current collector cannot provide worker-thread GC, simultaneous aggregate
peaks, queue-age, event-latency, recovery and exit distributions. Those gaps remain
`not-qualified`. Coverage flags alone cannot substitute for observations. Complete
future reports must carry all-related-process GC totals and identities, simultaneous
aggregate peaks, and populated ordered metric distributions. The validator checks
internal consistency; trustworthy capture/provenance remains an external obligation.

CPU comparison is suppressed whenever any identity, duration, aggregation,
reconciliation or coverage issue remains. Sources 808/796 specify complete metrics
and ten-minute windows, but no numeric CPU improvement target. The validator reports
`cpuThreshold.status: not-specified`; it neither creates a percentage target nor
infers improvement from component test time.

## Component Evidence Only

Tests use explicitly adversarial schema specimens, never committed measurement
reports or passing native evidence. They exercise malformed/missing input, host,
workload, budget, source/artifact, process/counter/generation, aggregation, duration,
final-result and coverage rejection. The retained real admission-refusal report is
also rejected. No paired measurement or native qualification was performed.

Previously recorded 799/800/802/807 failures describe the historical pins in
impl4; they are not a statement of current accepted 807 r2 status.
