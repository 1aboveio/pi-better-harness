# Aggregate Sample Cohorts

Issue 808 r6 adds one pure aggregation helper to the existing measurement fixture,
not a profiler, service or transport. The existing probe adds a monotonic sequence
within each measurement generation. No probe or native runtime is launched by the
new tests.

## Producer Contract

The existing collector retains minimal `aggregateCohorts` frames: process start
identity, generation, actual capture timestamp, sequence, cumulative CPU and RSS.
It reads the same atomic probe files during the existing 100ms control loop. It
does not run per-process OS liveness commands on every stream read; existing
endpoint identity/liveness checks remain in place.

`aggregateCohort` requires the complete expected PID/start identity set at the
SAME actual recorded timestamp. Both interval endpoints must have matching
identities/generation, consecutive per-process sequence values and monotonic CPU
counters. A gap beyond the existing 250ms sampling interval is rejected. CPU is
the sum of cumulative CPU differences divided by that one common interval; RSS
is summed only within a common timestamp cohort. Multi-core CPU may exceed 100%.

No timestamp bucketing, interpolation, process substitution or summing separate
process peaks is used. Independently timed probe callbacks may not provide aligned
cohorts; that is a real coverage gap, not a reason to stamp a shared fake time.
Native capture alignment has not been demonstrated.

`summarizeCohorts` ignores byte-equivalent repeated reads of the same samples,
rejects changed data under replayed sequence values, and never bridges an invalid
frame with a later CPU delta. Any missing/mixed-time/generation/identity/counter
gap or missing window boundary leaves `qualified:false` and both aggregate peaks
null. Valid partial intervals remain labeled observations, not full-window peaks.
Baseline RSS participates in the peak calculation.

The report retains `aggregatePeak` with method, exact cohort identities/generation,
coverage bounds, interval observations and gap reasons. Its coverage flag becomes
true only if all reported windows have complete cohort coverage. The paired-report
validator rebuilds the summary from retained frames and rejects inconsistent or
unsupported peak claims.

## Component Evidence Only

Controlled test inputs prove arithmetic and rejection, never load results. They
cover opposing per-process peaks, system CPU and multi-core arithmetic, initial
RSS, duplicate reads, missing/extra/duplicate/PID-reused processes, generation
changes, mixed timestamps, lost/replayed sequence, bad/reset counters, clock
reversal, missing intervals, missing boundaries and persistent gaps after recovery.
An affected paired-validator test rejects a claimed peak with no reproducible
cohort stream. No controlled values are emitted as actual measurement evidence.

## Still Missing

Real cohort alignment, native process coverage and diagnostic overhead measurement
remain unqualified. Worker-thread GC, queue age, event latency, recovery and exit
producers/coverage remain missing. Original both-OS, SAME fixed-host before/after
and at-least-ten-minute EACH workload bars remain unchanged. There is no invented
numeric CPU target, native progress or reset of prior no-progress history.

Primary and separately refused daemon admission evidence remains intact. No
native/probe launch, guard clearing, journal minting, alternate runtime/channel,
new resource or transport occurred in this source/component checkpoint.
