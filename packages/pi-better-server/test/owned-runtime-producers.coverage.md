# Owned Runtime Producers

These are source/component checks, not measured native qualification. The OS
capture and thread boundaries in the tests are injected. The executor, read
model, durable folds, reconciliation and producer composition are real code.

## Capture

The platform owner acquires a fresh requested PID batch. It retains the batch
start/end time, process birth identity and individual acquisition observations.
Previously timestamped independent records cannot be passed off as a new batch.
The strict timestamp, interval, generation, counter-reset and PID-set guards stay
in force. CPU totals use an explicit total-counter representation, not an invented
zero system-time component. Kernel tick scaling is a unit conversion, not temporal
interpolation. Batch provenance and native binding changes fence a window.

Linux reads kernel `/proc` counters, birth ticks and resident pages in one owned
acquisition. Kernel tick/page units are obtained before capture. Darwin uses an
in-process Node-API binding to `proc_pid_rusage`, not a per-capture `ps` child.
Thus the sampler's CPU and resident memory remain in the already measured owner
process. Zero child cost means no capture child exists; unavailable cost is never
replaced with zero. The validator retains the rejection for legacy unobserved
external-helper cost. The binding source and binary hashes are recorded and paired.

Primary API basis:

- Apple SDK `libproc.h` declares the read-only API; `sys/resource.h` defines V0
  CPU, resident bytes, birth and exit fields.
- [libproc wrapper](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c)
  forwards `proc_pid_rusage` to the kernel without counter conversion.
- [proc_info.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c)
  applies the same-user security policy before gathering resource data.
- [bsd_kern.c](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c)
  `fill_task_rusage` supplies Mach-time CPU counters and resident bytes;
  [task.c](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c)
  supplies `rm_time_mach`. The binding uses `mach_timebase_info`, preserves the
  exact integer birth token as text, and rejects exited or inaccessible PIDs.

The build helper compiles with stable Node-API8 headers, the running Node
architecture and system libproc. Missing headers fail closed without downloads,
runtime substitution or a PS fallback. Build-only verification does not load the
addon and does not call any process-capture API.

## Owned Controls And Metrics

The existing fixture loader captures the actual executor at construction, including
artifact copies. Its worker wrapper loads the exact worker source captured by that
factory. Private IPC follows only child handles created by the fixture, retains
original admission/guard environment, and has no public mutation RPC. Eviction
acknowledges clearing that worker's hot states; normal read replies refresh the
metrics mailbox. Restart terminates that captured thread handle and uses existing
bounded executor recovery. No shared/foreign PID is resolved or killed by controls.

GC observers cover registered main/read/loader threads with generation/birth and
freshness checks. Missing thread observations remain incomplete. Queue age reads
the actual executor queue. Event latency uses the existing commit-to-subscription
writer observer. Recovery times describe actual read-worker replacement; exit
waits for all related processes to leave naturally under unchanged lifecycle
policy, before forced-cleanup fallback. No control receipt, flag or later cleanup
can substitute for a missing action or observation.

## Campaign And Remainder

The default CLI requires an approved fixed-host/source/artifact/fixture config and
requests all18 workloads on each side with600000ms per window. Run separately on
each OS's fixed host. An absent baseline fixture remains an applicable, failed
original requirement, never a zero-cost baseline. Real reports must pass the
existing paired validator; injected incomplete reports cannot qualify. Explicit
`--smoke` preserves the existing CI job's short assertions and required names,
and cannot qualify as performance evidence.

No native fixture, platform capture, addon load, admission retry or campaign ran
locally. Both-OS physical processes/handles/SQLite/socket/lifecycle evidence and
all original eight criteria remain pending. The packed fixture now initializes
its actual foreground activity client before asserting that its owner is live;
the bbe dead-owner CI observation remains unverified locally, not accepted as live.
